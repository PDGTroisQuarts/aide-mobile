# aide-mobile

Script Tampermonkey pour téléphone (Firefox pour Android + Tampermonkey).

**Installer ou mettre à jour** : dans Firefox, ouvrir
<https://raw.githubusercontent.com/PDGTroisQuarts/aide-mobile/main/wiki-masters-mobile.user.js>
puis toucher « Installer » (ou « Mettre à jour ») sur la page de Tampermonkey.

Ensuite, Tampermonkey vérifie seul les nouvelles versions (une fois par jour
par défaut).

**v1.20.1** (19/10, avec le bot de l'ordinateur v1.10.1) : textes du shopping
(carte x1 🔥 ou 🔥🔥 : prix de revente pendant 2 jours, puis la médiane).

**v1.20.0** (19/10, avec le bot de l'ordinateur v1.10.0) :
- **🔥🔥** sur une carte vendue au moins 30 fois en 48 h (🔥 dès 16) ;
- bouton **❤ Je la veux !** à côté de 🛒 Shopping (fiche, page d'une enchère,
  Toutes les cartes) : le bot misera jusqu'au P70 (« Ambitieux ») au lieu de la
  médiane, et la surenchère suivra jusqu'au P70 ;
- télécommande : plafonds **Achat** (mise max de l'achat des bonnes affaires :
  au plus la vente rapide, 500 sous le P60, sous la médiane) et **Je la veux !**
  affichés quand le bot de l'ordinateur les a posés.

**v1.19.0** (15/10) : mise max pour revendre (encart d'une enchère, pastilles)
et plafond « Revente » de la télécommande = palier de revente du bot de
l'ordinateur (v1.8.12) : prix « Normal » − 300 s'il dépasse la vente rapide de
plus de 100, sinon vente rapide − 300, toujours sous la médiane (avant : vente
rapide − 400). Réglage « revente − 400 » gardé dans les réglages remplacé.

**v1.18.0** (14/10) : sur « Toutes les cartes » (global-collection), la fiche
ouverte propose aussi **🛒 Shopping : x1 / En continu**.

**v1.17.0** (13/10) : étoiles jusqu'à 5 (une demi-étoile par 100 wikibidous de
gain, comme sur l'ordinateur), mise max pour revendre = vente rapide − 400
(2 étoiles), bouton **🛒 Shopping : x1 / En continu** sur la fiche d'une carte
et sur la page d'une enchère : la carte (à sa rareté) est ajoutée à la liste du
bot shopping de l'ordinateur (bot v1.8.6 ou plus récent), qui l'applique dans
la minute. Il faut le sujet ntfy de la télécommande (menu « Télécommande des
enchères »). Menu **Tableau de bord** : ouvre la page ci-dessous.

## Tableau de bord des appareils

Page à ouvrir sur le téléphone, l'ordinateur ou la tablette (n'importe quel
navigateur) : état de la tablette et de l'ordinateur, état de chaque bot,
bouton « Relancer », liste du bot shopping (ajout, retrait).

<https://raw.githack.com/PDGTroisQuarts/aide-mobile/main/tableau-de-bord.html>

Au premier passage, la page demande le sujet ntfy (le même que dans le menu
Tampermonkey, « Notification : Régler ») et le garde dans le navigateur. On
peut aussi l'ajouter à la fin de l'adresse : `…/tableau-de-bord.html#mon-sujet`.
La page ne contient aucune donnée personnelle ; elle ne parle qu'à ntfy.sh.
