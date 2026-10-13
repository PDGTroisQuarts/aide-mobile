# aide-mobile

Script Tampermonkey pour téléphone (Firefox pour Android + Tampermonkey).

**Installer ou mettre à jour** : dans Firefox, ouvrir
<https://raw.githubusercontent.com/PDGTroisQuarts/aide-mobile/main/wiki-masters-mobile.user.js>
puis toucher « Installer » (ou « Mettre à jour ») sur la page de Tampermonkey.

Ensuite, Tampermonkey vérifie seul les nouvelles versions (une fois par jour
par défaut).

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
