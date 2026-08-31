# Sonos

Contrôlez vos enceintes Sonos directement sur votre réseau local : lecture,
pause, morceau précédent/suivant, volume, et lecture de n'importe quelle URI
de contenu (une playlist ou un morceau Spotify, un flux radio...) envoyée
depuis, typiquement, une scène Gladys.

## Pourquoi cette intégration, en plus du service Sonos natif de Gladys

- **Découverte compatible VLAN.** Le service Sonos natif ne trouve les
  enceintes que par multicast SSDP (`239.255.255.250:1900`), que la plupart
  des routeurs ne relaient pas entre VLAN/sous-réseaux — une limitation
  actuellement non résolue. Cette intégration ajoute un champ **IPs
  connues** : l'IP d'une seule enceinte joignable suffit, car les enceintes
  Sonos connaissent déjà toutes les pièces de l'installation et partagent
  cette organisation avec celle qu'on interroge.
- **Lecture de n'importe quelle URI.** Chaque appareil dispose d'une
  fonctionnalité « Lire une URI » : envoyez-lui une URI (ex.
  `spotify:playlist:...`) et la lecture démarre dessus. Combinez-la avec une
  intégration qui liste des contenus (playlists, morceaux récents...) via une
  scène Gladys : lisez la valeur sélectionnée, écrivez-la sur « Lire une
  URI ».

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Si vos enceintes Sonos sont joignables depuis Gladys sans configuration
   réseau particulière, laissez **IPs connues** vide et lancez un scan — la
   découverte automatique (SSDP) suffit.
3. Si Gladys et vos enceintes Sonos sont sur des VLAN/sous-réseaux
   différents, renseignez l'adresse IP d'**une** enceinte dans **IPs
   connues**, enregistrez, puis lancez un scan (action **Rechercher les
   enceintes Sonos**, ou l'onglet Découverte). Cette seule IP suffit à
   retrouver toutes les pièces.

## Faire le pont avec le contenu d'une autre intégration

La fonctionnalité « Lire une URI » d'un appareil accepte n'importe quelle
valeur texte via sa commande `text` standard — aucun câblage particulier
nécessaire. Dans une scène Gladys : lisez l'état de la fonctionnalité qui
liste le contenu à lancer (comme déclencheur), puis ajoutez une action qui
écrit cette même valeur sur « Lire une URI » de cet appareil.

## Limites

- Contrôle réseau local uniquement : aucun compte cloud, rien ne fonctionne
  si l'enceinte n'est pas joignable à l'adresse IP que Gladys a actuellement
  pour elle.
- Pas de mise à jour temps réel (lecture/pause, volume) : l'état est
  interrogé périodiquement, le tableau de bord peut donc avoir quelques
  secondes de retard.
- La topologie des groupes/paires stéréo n'est lue qu'à chaque scan ; un
  appareil regroupé après le dernier scan est piloté directement plutôt que
  via le coordinateur de son groupe.
- Lire une URI (`spotify:...`, etc.) suppose que l'enceinte visée prenne déjà
  nativement en charge cette source de contenu (ex. Spotify lié comme service
  dans l'app Sonos) — cette intégration ne gère pas cette liaison de compte,
  elle se contente d'envoyer l'URI sur le réseau local.
