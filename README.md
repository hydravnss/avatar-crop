# Avatar Crop

Extension [SillyTavern](https://github.com/SillyTavern/SillyTavern) pour **zoomer, dézoomer et recadrer** une image au moment où tu l’envoies comme photo de profil d’un personnage (bot). Tu peux aussi l’utiliser pour les personas et les groupes.

Pensée pour iPhone (pincement + boutons − / +). Interface en français. Testée vis-à-vis de SillyTavern 1.19.

## Installation

1. Ouvre SillyTavern → **Extensions** (icône des cubes) → **Install extension**.
2. Colle l’URL : `https://github.com/hydravnss/avatar-crop`
3. Valide, puis recharge la page.
4. Les réglages sont dans **Extensions → Avatar Crop**.

## Utilisation

Quand tu choisis une image pour l’avatar d’un bot :

1. Un éditeur s’ouvre à la place du popup natif de SillyTavern.
2. Choisis le ratio : **2:3** (portrait, standard des personnages ST), **1:1** (carré) ou **Original**.
3. **Zoome** avec le bouton **+**, **dézoome** avec **−**, le curseur, la molette, ou un pincement.
4. **Glisse** l’image pour cadrer le visages ou le détail que tu veux garder.
5. Appuie sur **Valider** : seule la zone visible est enregistrée.

Les GIF sont envoyés tels quels, pour ne pas perdre l’animation.

## Pourquoi pas le recadrage natif ?

Le popup Cropper.js de SillyTavern impose un cadre 2:3 qui remplit l’image (`autoCropArea: 1`). Sur une photo paysage, il ne garde souvent que la bande centrale, et le serveur recadre encore (`crop` puis `cover` 512×768). Ici tu contrôles le zoom et le cadrage, puis l’image déjà recadrée est envoyée.

L’extension active le réglage natif « Ne jamais redimensionner les avatars » pour empêcher ce popup de s’ouvrir ensuite. Ta valeur d’origine est restaurée si tu désactives l’extension.

## Avec [No Crop Avatar](https://github.com/hydravnss/no-crop-avatar)

Les deux peuvent cohabiter. Avatar Crop (ordre de chargement 5) intercepte le fichier **en premier**, ouvre l’éditeur, puis redispatche l’image déjà recadrée. No Crop Avatar (ordre 10) la voit ensuite : en mode « garder l’image entière », elle ne la retire pas ; en mode « toile » 2:3, une image déjà en 2:3 ne change pratiquement pas.

Si tu veux seulement empêcher tout recadrage, garde No Crop Avatar seule. Si tu veux choisir toi-même le zoom et le cadre, installe Avatar Crop.

## Réglages

- Activer
- Appliquer aux personnages (bots), personas, groupes
- Ratio par défaut
- Taille max du côté long (1536 px par défaut, pour éviter les énormes photos d’iPhone)

## Licence

MIT
