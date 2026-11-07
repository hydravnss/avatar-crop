/**
 * Avatar Crop — zoom, dézoom et recadrage à l'upload d'un avatar.
 *
 * SillyTavern ouvre sinon Cropper.js (popup.js, POPUP_TYPE.CROP) avec un cadre 2:3
 * (autoCropArea 1) puis envoie ?crop=… ; le serveur fait crop() + cover(512×768).
 * Sur une photo paysage le cadre natif garde surtout la bande centrale, sans vrai
 * contrôle du zoom. Cette extension remplace ce popup par un éditeur
 * (boutons +/−, pincement, glisser) et injecte déjà l'image recadrée.
 * On force « Ne jamais redimensionner les avatars » pour que le popup natif
 * ne s'ouvre pas ensuite. Sans zoom, l'image entière est posée sur une toile 2:3
 * (bandes, sans rogner) : sinon les miniatures serveur (cover 96×144) zoomeraient
 * encore les listes. Compatible avec No Crop Avatar (loading_order 5 < 10) :
 * on intercepte en premier, puis on redispatche le fichier déjà préparé.
 */

const MODULE_NAME = 'avatar_crop';
const LOG = '[Avatar Crop]';

/** Quel <input type=file> → type d'avatar, et quel évènement ST écoute. */
const INPUTS = {
    add_avatar_button: { kind: 'char', event: 'change' },
    avatar_upload_file: { kind: 'persona', event: 'change' },
    group_avatar_button: { kind: 'group', event: 'input' },
};

const defaultSettings = Object.freeze({
    enabled: true,
    applyChar: true,
    applyPersona: true,
    applyGroup: true,
    defaultRatio: '2:3', // 2:3 | 1:1 | original
    maxSide: 1536,
    forceNoResize: true,
    prevNeverResize: null,
});

const MAX_ZOOM = 5;
const ZOOM_STEP = 1.15;

const ctx = () => SillyTavern.getContext();
const $ = (sel) => window.jQuery(sel);
const save = () => ctx().saveSettingsDebounced();
const toast = (type, msg) => { try { window.toastr?.[type]?.(msg, 'Avatar Crop'); } catch { /* ignore */ } };

let settings = null;
let powerUser = null;
let busy = false;

function loadSettings() {
    const store = ctx().extensionSettings;
    store[MODULE_NAME] = Object.assign({}, defaultSettings, store[MODULE_NAME] || {});
    settings = store[MODULE_NAME];
}

function kindEnabled(kind) {
    if (kind === 'char') return settings.applyChar;
    if (kind === 'persona') return settings.applyPersona;
    if (kind === 'group') return settings.applyGroup;
    return false;
}

/* ------------------------------------------------------------------ réglage ST « Ne jamais redimensionner » */

async function getPowerUser() {
    if (!powerUser) {
        try { powerUser = (await import('/scripts/power-user.js')).power_user; } catch (err) { console.warn(LOG, 'power-user.js indisponible', err); }
    }
    return powerUser;
}

async function syncForceNoResize() {
    const pu = await getPowerUser();
    if (!pu) return;
    const want = settings.enabled && settings.forceNoResize;
    if (want) {
        if (!pu.never_resize_avatars) {
            if (settings.prevNeverResize === null) settings.prevNeverResize = false;
            pu.never_resize_avatars = true;
            $('#never_resize_avatars').prop('checked', true);
            save();
        }
    } else if (settings.prevNeverResize !== null) {
        pu.never_resize_avatars = !!settings.prevNeverResize;
        $('#never_resize_avatars').prop('checked', pu.never_resize_avatars);
        settings.prevNeverResize = null;
        save();
    }
}

/* ------------------------------------------------------------------ interception du fichier */

function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('décodage impossible'));
        img.src = url;
    });
}

function parseRatio(str, img) {
    if (str === 'original') return img.naturalWidth / Math.max(1, img.naturalHeight);
    const m = /^(\d+):(\d+)$/.exec(str || '');
    return m ? Number(m[1]) / Number(m[2]) : img.naturalWidth / Math.max(1, img.naturalHeight);
}

function onFileEvent(ev) {
    const input = ev.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
    const meta = INPUTS[input.id];
    if (!meta || ev.type !== meta.event) return;
    if (!settings?.enabled || !kindEnabled(meta.kind)) return;
    const file = input.files && input.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (file._acProcessed) return;
    if (file.type === 'image/gif') {
        toast('info', 'GIF conservé tel quel (pas de recadrage, pour garder l’animation).');
        return;
    }

    // Empêche ST (et les autres extensions) de voir ce choix brut : on redispatche après recadrage.
    ev.stopImmediatePropagation();
    ev.preventDefault();
    openEditor(input, file, meta);
}

async function openEditor(input, file, meta) {
    if (busy) return;
    busy = true;
    const url = URL.createObjectURL(file);
    try {
        const img = await loadImageFromUrl(url);
        const cropped = await showModal(img, file);
        if (!cropped) {
            input.value = '';
            return;
        }
        cropped._acProcessed = true;
        const dt = new DataTransfer();
        dt.items.add(cropped);
        input.files = dt.files;
        input.dispatchEvent(new Event(meta.event, { bubbles: true }));
    } catch (err) {
        console.warn(LOG, err);
        toast('error', 'Impossible de recadrer cette image.');
        input.value = '';
    } finally {
        URL.revokeObjectURL(url);
        busy = false;
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Pose l'image entière au centre d'une toile au ratio donné, sans rogner.
 * Nécessaire parce que ST fabrique les miniatures de liste avec cover(96×144) :
 * une photo paysage envoyée telle quelle se retrouve zoomée dans le cercle.
 */
async function letterboxToRatio(img, file, ratioStr) {
    const ratio = parseRatio(ratioStr === 'original' ? '2:3' : (ratioStr || '2:3'), img);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return file;

    let cw = iw;
    let ch = ih;
    if (iw / ih > ratio) ch = iw / ratio;
    else cw = ih * ratio;

    const maxSide = Number(settings.maxSide) > 0 ? Number(settings.maxSide) : 1536;
    let scale = 1;
    if (Math.max(cw, ch) > maxSide) scale = maxSide / Math.max(cw, ch);

    const W = Math.max(1, Math.round(cw * scale));
    const H = Math.max(1, Math.round(ch * scale));
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);

    if (Math.abs(W - dw) <= 1 && Math.abs(H - dh) <= 1 && scale >= 0.999) {
        return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.fillStyle = '#111111';
    c.fillRect(0, 0, W, H);
    c.drawImage(img, dx, dy, dw, dh);

    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    if (!blob) return file;
    const base = (file.name || 'avatar').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}

function applyViewportSize(viewport, ratio) {
    const maxW = Math.min(window.innerWidth * 0.72, 320);
    const maxH = Math.min(window.innerHeight * 0.52, 420);
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
        h = maxH;
        w = h * ratio;
    }
    viewport.style.width = `${Math.round(w)}px`;
    viewport.style.height = `${Math.round(h)}px`;
    viewport.style.aspectRatio = `${ratio}`;
}

function showModal(img, file) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ac-modal';
        overlay.innerHTML = `
            <div class="ac-dialog">
                <p class="ac-title">Recadrer la photo</p>
                <div class="ac-ratios">
                    <button type="button" data-ratio="2:3">2:3</button>
                    <button type="button" data-ratio="1:1">1:1</button>
                    <button type="button" data-ratio="original">Original</button>
                </div>
                <div class="ac-stage">
                    <div class="ac-viewport">
                        <img alt="">
                        <div class="ac-frame"></div>
                    </div>
                </div>
                <div class="ac-zoom">
                    <button type="button" class="ac-zoom-out" aria-label="Dézoomer">−</button>
                    <input type="range" class="ac-zoom-range" min="1" max="${MAX_ZOOM}" step="0.01" value="1">
                    <button type="button" class="ac-zoom-in" aria-label="Zoomer">+</button>
                </div>
                <div class="ac-actions">
                    <button type="button" class="ac-cancel">Annuler</button>
                    <button type="button" class="ac-ok">Valider</button>
                </div>
            </div>`;

        // Plein écran au-dessus des panneaux ST (éditeur perso, drawers) et hors
        // de tout ancêtre transformé qui casserait position:fixed. On évite
        // role=dialog / aria-modal : iOS Safari en fait une fausse « petite
        // fenêtre » dans la barre de titre, souvent sans afficher l'overlay.
        overlay.setAttribute('role', 'presentation');
        overlay.style.cssText = [
            'position:fixed',
            'top:0','left:0','right:0','bottom:0',
            'width:100vw','height:100vh','height:100dvh',
            'z-index:2147483646',
            'display:flex','align-items:center','justify-content:center',
            'padding:16px','margin:0','transform:none',
            'background:rgba(0,0,0,0.78)',
            'box-sizing:border-box',
        ].join(';');
        const prevOverflow = document.body.style.overflow;
        const prevTitle = document.title;
        document.body.style.overflow = 'hidden';
        document.documentElement.appendChild(overlay);

        const viewport = overlay.querySelector('.ac-viewport');
        const preview = overlay.querySelector('.ac-viewport img');
        const range = overlay.querySelector('.ac-zoom-range');
        preview.src = img.src;

        let ratioKey = settings.defaultRatio || '2:3';
        let userZoom = 1;
        let ox = 0;
        let oy = 0;
        let baseScale = 1;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let pinchStartDist = 0;
        let pinchStartZoom = 1;
        let pinchMid = null;
        let closed = false;

        const finish = (value) => {
            if (closed) return;
            closed = true;
            overlay.remove();
            document.body.style.overflow = prevOverflow;
            if (document.title !== prevTitle) document.title = prevTitle;
            resolve(value);
        };

        const displayedScale = () => baseScale * userZoom;

        const clampPan = () => {
            const W = viewport.clientWidth;
            const H = viewport.clientHeight;
            const s = displayedScale();
            const dw = img.naturalWidth * s;
            const dh = img.naturalHeight * s;
            if (dw >= W) {
                ox = Math.min(0, Math.max(W - dw, ox));
            } else {
                ox = (W - dw) / 2;
            }
            if (dh >= H) {
                oy = Math.min(0, Math.max(H - dh, oy));
            } else {
                oy = (H - dh) / 2;
            }
        };

        const paint = () => {
            const s = displayedScale();
            preview.style.width = `${img.naturalWidth}px`;
            preview.style.height = `${img.naturalHeight}px`;
            preview.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
            range.value = String(userZoom);
        };

        const zoomAround = (nextZoom, cx, cy) => {
            nextZoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
            const s0 = displayedScale();
            const imgX = (cx - ox) / s0;
            const imgY = (cy - oy) / s0;
            userZoom = nextZoom;
            const s1 = displayedScale();
            ox = cx - imgX * s1;
            oy = cy - imgY * s1;
            clampPan();
            paint();
        };

        const fit = () => {
            const ratio = parseRatio(ratioKey, img);
            applyViewportSize(viewport, ratio);
            const W = viewport.clientWidth;
            const H = viewport.clientHeight;
            // Contenir (min) et non couvrir (max) : au zoom 1 toute l'image est visible.
            // L'ancien max() remplissait le cadre 2:3 et recadrait tout seul.
            baseScale = Math.min(W / img.naturalWidth, H / img.naturalHeight) || 1;
            userZoom = 1;
            const s = displayedScale();
            ox = (W - img.naturalWidth * s) / 2;
            oy = (H - img.naturalHeight * s) / 2;
            clampPan();
            overlay.querySelectorAll('.ac-ratios button').forEach((btn) => {
                btn.classList.toggle('ac-active', btn.dataset.ratio === ratioKey);
            });
            paint();
        };

        overlay.querySelectorAll('.ac-ratios button').forEach((btn) => {
            btn.addEventListener('click', () => {
                ratioKey = btn.dataset.ratio;
                fit();
            });
        });

        overlay.querySelector('.ac-zoom-in').addEventListener('click', () => {
            zoomAround(userZoom * ZOOM_STEP, viewport.clientWidth / 2, viewport.clientHeight / 2);
        });
        overlay.querySelector('.ac-zoom-out').addEventListener('click', () => {
            zoomAround(userZoom / ZOOM_STEP, viewport.clientWidth / 2, viewport.clientHeight / 2);
        });
        range.addEventListener('input', () => {
            zoomAround(Number(range.value), viewport.clientWidth / 2, viewport.clientHeight / 2);
        });

        const pointerPos = (touch, el) => {
            const r = el.getBoundingClientRect();
            return { x: touch.clientX - r.left, y: touch.clientY - r.top };
        };

        viewport.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            viewport.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        viewport.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            ox += e.clientX - lastX;
            oy += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            clampPan();
            paint();
        });
        const endDrag = () => { dragging = false; };
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);

        viewport.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                dragging = true;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                dragging = false;
                const [a, b] = e.touches;
                pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                pinchStartZoom = userZoom;
                const p1 = pointerPos(a, viewport);
                const p2 = pointerPos(b, viewport);
                pinchMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            }
            e.preventDefault();
        }, { passive: false });

        viewport.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && pinchStartDist) {
                const [a, b] = e.touches;
                const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                const p1 = pointerPos(a, viewport);
                const p2 = pointerPos(b, viewport);
                const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                zoomAround(pinchStartZoom * (dist / pinchStartDist), mid.x, mid.y);
            } else if (e.touches.length === 1 && dragging) {
                ox += e.touches[0].clientX - lastX;
                oy += e.touches[0].clientY - lastY;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
                clampPan();
                paint();
            }
            e.preventDefault();
        }, { passive: false });

        viewport.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) {
                pinchStartDist = 0;
                pinchMid = null;
            }
            if (e.touches.length === 1) {
                dragging = true;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
            }
            if (e.touches.length === 0) dragging = false;
        });

        viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            const pos = pointerPos(e, viewport);
            const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            zoomAround(userZoom * factor, pos.x, pos.y);
        }, { passive: false });

        overlay.querySelector('.ac-cancel').addEventListener('click', () => finish(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(null);
        });

        overlay.querySelector('.ac-ok').addEventListener('click', async () => {
            try {
                // Pas zoomé = image entière, posée sur une toile 2:3 (sans rogner)
                // pour que les miniatures ST (cover 96×144) ne zooment plus les côtés.
                if (userZoom <= 1.001) {
                    finish(await letterboxToRatio(img, file, '2:3'));
                    return;
                }
                const s = displayedScale();
                const srcX = -ox / s;
                const srcY = -oy / s;
                const srcW = viewport.clientWidth / s;
                const srcH = viewport.clientHeight / s;
                const maxSide = Number(settings.maxSide) > 0 ? Number(settings.maxSide) : 1536;
                let outW;
                let outH;
                if (srcW >= srcH) {
                    outW = Math.max(1, Math.min(maxSide, Math.round(srcW)));
                    outH = Math.max(1, Math.round(outW * srcH / srcW));
                } else {
                    outH = Math.max(1, Math.min(maxSide, Math.round(srcH)));
                    outW = Math.max(1, Math.round(outH * srcW / srcH));
                }
                const canvas = document.createElement('canvas');
                canvas.width = outW;
                canvas.height = outH;
                const c = canvas.getContext('2d');
                c.imageSmoothingEnabled = true;
                c.imageSmoothingQuality = 'high';
                c.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

                const keepPng = file.type === 'image/png' || file.type === 'image/webp';
                const type = keepPng ? 'image/png' : 'image/jpeg';
                const blob = await canvasToBlob(canvas, type, keepPng ? undefined : 0.92);
                if (!blob) throw new Error('export canvas');
                const base = (file.name || 'avatar').replace(/\.[^.]+$/, '');
                const ext = keepPng ? 'png' : 'jpg';
                finish(new File([blob], `${base}.${ext}`, { type, lastModified: Date.now() }));
            } catch (err) {
                console.warn(LOG, err);
                toast('error', 'Le recadrage a échoué.');
            }
        });

        requestAnimationFrame(() => {
            fit();
            setTimeout(fit, 50);
        });
    });
}

/* ------------------------------------------------------------------ affichage : pas de zoom CSS ni de miniatures recadrées */

function applyCss() {
    document.body.classList.toggle('ac-contain', !!(settings && settings.enabled));
}

const THUMB_RE = /^\/thumbnail\?type=(avatar|persona)&file=([^&]+)(?:&t=\d+)?$/;
let thumbObserver = null;

function originalUrlFor(src) {
    let path = src;
    try { const u = new URL(src, location.origin); path = u.pathname + u.search; } catch { /* ignore */ }
    const m = THUMB_RE.exec(path);
    if (!m) return null;
    return m[1] === 'avatar' ? `/characters/${m[2]}` : `/User Avatars/${m[2]}`;
}

function bypassThumb(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (!settings?.enabled) return;
    const src = img.getAttribute('src');
    if (!src) return;
    const orig = originalUrlFor(src);
    if (!orig) return;
    img.dataset.acOrig = src;
    img.setAttribute('src', orig);
}

function restoreThumbs() {
    document.querySelectorAll('img[data-ac-orig]').forEach((img) => {
        img.setAttribute('src', img.dataset.acOrig);
        delete img.dataset.acOrig;
    });
}

function scanThumbs() {
    if (!settings?.enabled) return;
    document.querySelectorAll('img[src*="/thumbnail?"]').forEach(bypassThumb);
}

function refreshThumbs() {
    const ts = Date.now();
    document.querySelectorAll('img[data-ac-orig]').forEach((img) => {
        const base = originalUrlFor(img.dataset.acOrig) || '';
        if (base) img.setAttribute('src', `${base}?ac=${ts}`);
    });
}

function startThumbObserver() {
    if (thumbObserver) return;
    thumbObserver = new MutationObserver((records) => {
        if (!settings?.enabled) return;
        for (const r of records) {
            if (r.type === 'attributes') {
                const img = r.target;
                if (img instanceof HTMLImageElement && /\/thumbnail\?/.test(img.getAttribute('src') || '')) {
                    bypassThumb(img);
                }
            } else {
                r.addedNodes.forEach((n) => {
                    if (!(n instanceof Element)) return;
                    if (n instanceof HTMLImageElement) bypassThumb(n);
                    else n.querySelectorAll?.('img[src*="/thumbnail?"]').forEach(bypassThumb);
                });
            }
        }
    });
    thumbObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src'],
    });
}

/* ------------------------------------------------------------------ réglages */

const SETTINGS_HTML = `
<div id="ac_settings" class="extension_container">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Avatar Crop</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="ac-hint">À l’upload d’une photo de profil, un éditeur s’ouvre pour zoomer, dézoomer et recadrer. Le popup natif de SillyTavern est remplacé.</div>
      <div class="ac-row">
        <label for="ac_enabled">Activer</label>
        <input type="checkbox" id="ac_enabled">
      </div>
      <div class="ac-section">Où l’appliquer</div>
      <div class="ac-row">
        <label for="ac_char">Personnages (bots)</label>
        <input type="checkbox" id="ac_char">
      </div>
      <div class="ac-row">
        <label for="ac_persona">Personas</label>
        <input type="checkbox" id="ac_persona">
      </div>
      <div class="ac-row">
        <label for="ac_group">Groupes</label>
        <input type="checkbox" id="ac_group">
      </div>
      <div class="ac-section">Recadrage</div>
      <div class="ac-row">
        <label for="ac_ratio">Ratio par défaut</label>
        <select id="ac_ratio" class="text_pole">
          <option value="2:3">2:3 (portrait, standard ST)</option>
          <option value="1:1">1:1 (carré)</option>
          <option value="original">Original (ratio de l’image)</option>
        </select>
      </div>
      <div class="ac-row">
        <label for="ac_max">Taille max du côté long (px)</label>
        <input type="number" id="ac_max" class="text_pole" min="256" max="4096" step="64">
      </div>
      <div class="ac-hint">Pincer pour zoomer, glisser pour cadrer, ou utiliser les boutons − et +. Sans zoom, l’image entière est posée sur une toile 2:3 (bandes, sans recadrage) pour que les listes de SillyTavern ne zooment plus. Les GIF restent intacts.</div>
    </div>
  </div>
</div>`;

function bindSettingsUi() {
    const q = (id) => document.getElementById(id);
    const refreshUi = () => {
        q('ac_enabled').checked = settings.enabled;
        q('ac_char').checked = settings.applyChar;
        q('ac_persona').checked = settings.applyPersona;
        q('ac_group').checked = settings.applyGroup;
        q('ac_ratio').value = settings.defaultRatio;
        q('ac_max').value = String(settings.maxSide);
    };
    const bind = (id, key, { num = false, bool = false, after } = {}) => {
        q(id).addEventListener('input', () => {
            const el = q(id);
            let v = bool ? el.checked : el.value;
            if (num) v = Number(v);
            settings[key] = v;
            save();
            refreshUi();
            after?.();
        });
    };
    bind('ac_enabled', 'enabled', { bool: true, after: () => {
        syncForceNoResize();
        applyCss();
        if (settings.enabled) scanThumbs();
        else restoreThumbs();
    } });
    bind('ac_char', 'applyChar', { bool: true });
    bind('ac_persona', 'applyPersona', { bool: true });
    bind('ac_group', 'applyGroup', { bool: true });
    bind('ac_ratio', 'defaultRatio');
    bind('ac_max', 'maxSide', { num: true });
    refreshUi();
}

/* ------------------------------------------------------------------ init */

jQuery(async () => {
    loadSettings();
    document.addEventListener('change', onFileEvent, true);
    document.addEventListener('input', onFileEvent, true);
    $('#extensions_settings2').append(SETTINGS_HTML);
    bindSettingsUi();

    $(document).on('input', '#never_resize_avatars', () => {
        if (settings.enabled && settings.forceNoResize && powerUser && !powerUser.never_resize_avatars) {
            setTimeout(() => {
                syncForceNoResize();
                toast('info', 'Option verrouillée par Avatar Crop (désactive l’extension pour la changer).');
            }, 0);
        }
    });

    applyCss();
    startThumbObserver();
    scanThumbs();

    try {
        const { eventSource, event_types } = ctx();
        const sync = () => {
            syncForceNoResize();
            applyCss();
            if (settings.enabled) scanThumbs();
            else restoreThumbs();
        };
        eventSource.on(event_types.APP_READY, sync);
        eventSource.on(event_types.SETTINGS_LOADED_AFTER, sync);
        if (event_types.CHARACTER_EDITED) {
            eventSource.on(event_types.CHARACTER_EDITED, () => setTimeout(refreshThumbs, 300));
        }
        if (event_types.PERSONA_CHANGED) {
            eventSource.on(event_types.PERSONA_CHANGED, () => setTimeout(scanThumbs, 100));
        }
    } catch (err) {
        console.debug(LOG, 'évènements indisponibles', err);
    }
    await syncForceNoResize();
    console.log(LOG, 'chargé');
});
