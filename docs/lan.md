# Accès depuis un téléphone

[English](en/lan.md) · **Français** · [← Retour au README](../README.fr.md)

## Utiliser le studio depuis un téléphone

L’accès mobile est facultatif, protégé par un code à huit chiffres. Il donne accès aux commandes du studio sur le même réseau Wi-Fi : ouvrir un projet et ses sessions, envoyer des messages, créer ou reprendre une conversation, choisir un modèle, arrêter une exécution et organiser les projets et sessions. Les agents travaillent sur le PC et continuent si vous fermez le navigateur du téléphone.

Sur le PC, ouvrez **Préférences → Accès distant** et activez **Réseau local**. Le Studio détecte les interfaces Wi-Fi et Ethernet. La connexion s’ouvre immédiatement, sans redémarrer le Studio ni interrompre les agents.

À la première activation, notez le PIN de huit chiffres affiché une seule fois. Les activations et désactivations suivantes du LAN ou de Tailscale conservent ce code. **Copier le lien** copie l’adresse active ; **QR code** affiche un QR contenant uniquement l’URL, jamais le PIN. Scannez-le depuis un téléphone sur le même réseau puis saisissez le PIN. Le cookie de connexion dure huit heures.

**Options de connexion** permet de choisir l’interface et le port. Après un changement de port, ouvrez le nouveau lien sur vos appareils. Un échec d’ouverture ou d’enregistrement conserve la connexion précédente. Si une adresse disparaît, le panneau signale l’erreur ; actualisez et choisissez une interface connectée. La configuration reste dans `.local/lan-access.json`.

Le port mobile par défaut est `3089`, commun au LAN et à Tailscale, lié uniquement aux adresses choisies. Le port `3088` reste réservé au PC. Aucun routeur, tunnel Internet ou règle de pare-feu Windows n’est configuré. La connexion LAN utilise HTTP sur votre réseau local. Le PC doit rester allumé et connecté ; si le téléphone ne se connecte pas malgré une écoute active, vérifiez son réseau et le pare-feu du PC.

## Modifier le code PIN sur le PC

Dans l’interface locale du PC, ouvrez **Préférences → Accès distant → Changer le code**. Saisissez et confirmez un nouveau code de **8 chiffres** ; un zéro initial est accepté. Le code reste commun aux accès Wi-Fi, Tailscale et PWA.

Le changement s’applique immédiatement, sans redémarrage du Studio. Les appareils déjà connectés sont déconnectés et doivent saisir le nouveau code ; les agents continuent leur travail. Les adresses, les ports et les permissions restent identiques. Le code n’est enregistré ni en clair sur le PC, ni dans le stockage du navigateur.

Ce panneau et ses routes sont réservés à l’adresse locale du PC. Il permet de modifier un accès mobile déjà configuré ; si vous avez oublié l’ancien code, vous pouvez en choisir un nouveau depuis le PC.

![Changement du code mobile depuis les préférences du PC, avec confirmation du nouveau PIN.](screenshots/desktop-remote-pin.png)

## Utiliser les commandes à distance

Dans le menu, choisissez un projet pour afficher ses sessions dans la page, puis touchez une session pour l’ouvrir. **Nouvelle session** prépare une conversation dans ce projet. Les sessions archivées restent accessibles avec le filtre **Archivées**.

Les boutons **Photo** et **Pièce jointe** sélectionnent respectivement les images et tous types de fichiers du téléphone. Les pièces sont transférées au PC lors de l’envoi, y compris en **Réorienter** ou **À la suite**. Touchez une image reçue pour l’agrandir, ou un fichier pour le télécharger. Les limites sont les mêmes que sur PC : [images et pièces jointes](navigation.md#images-et-pièces-jointes).

La configuration `readOnly: false` active les commandes à distance. Pour limiter cet accès à la consultation, choisissez **Lecture seule** dans **Autorisations à distance**. Une ancienne configuration sans ce champ reste en lecture seule jusqu’à sa mise à jour explicite. Le changement s’applique immédiatement et conserve le PIN ; les appareils doivent se reconnecter, les agents continuent.

## Hors du Wi-Fi avec Tailscale

Installez Tailscale sur le PC et le téléphone, connectez-les au même réseau Tailscale (le même compte pour un usage personnel), puis activez la connexion sur les deux appareils.

Dans **Préférences → Accès distant**, activez **Tailscale**. Le panneau utilise l’interface Tailscale déjà connectée et affiche l’adresse `http://100.x.y.z:3089`. Il conserve le LAN, le port, le PIN et les permissions. Si aucun accès distant n’était configuré, il crée un PIN sans activer le LAN. Le Studio n’installe pas Tailscale et ne connecte pas votre compte à votre place.

L’activation s’applique immédiatement. Depuis le téléphone en 4G/5G, activez Tailscale et ouvrez le lien ou scannez le QR. Cet accès HTTP fonctionne sans Tailscale Serve ; [l’installation PWA](pwa.md) utilise Serve pour fournir HTTPS. La carte **Tailscale HTTPS** permet de configurer cet accès depuis le même panneau, sans redémarrage, avec son propre lien et QR.

Le Studio ouvre une seconde écoute sur l’adresse IPv4 de l’interface Tailscale, en plus de celle du LAN. Cette passerelle n’accepte que les pairs de la plage Tailscale `100.64.0.0/10` et les connexions locales ; l’authentification du Studio reste obligatoire. Le trafic entre appareils est chiffré par Tailscale. Le configurateur de modèles et les routes réservées au PC restent inaccessibles à distance.

La configuration reste dans `.local/lan-access.json`. Les interrupteurs contrôlent le LAN et l’accès HTTP Tailscale indépendamment ; l’éventuelle passerelle PWA utilise `tailscale.https.enabled`. Ces accès partagent le PIN et les permissions, mais demandent chacun une connexion dans le navigateur. Désactiver un accès ferme ses connexions distantes ; les agents et l’accès local continuent.

Si Tailscale était absent au démarrage ou si son adresse change, connectez-le, actualisez le panneau puis appliquez ses options. Aucun redémarrage du Studio n’est nécessaire.

En cas d’échec depuis le téléphone, vérifiez que le PC est allumé, que Tailscale est connecté sur les deux appareils et que les règles de votre réseau Tailscale et du pare-feu Windows autorisent le port choisi. Une erreur Tailscale au démarrage ne désactive pas le LAN ; les diagnostics apparaissent dans `.local/logs/server.log`.

[Connexion entre appareils : documentation Tailscale](https://tailscale.com/docs/how-to/connect-to-devices).

## Commandes existantes et mise à jour

Les commandes `npm run lan:enable` et `npm run tailscale:enable` restent disponibles pour la configuration en terminal. Elles modifient le fichier utilisé au prochain démarrage ; `lan:enable` renouvelle aussi le PIN partagé. Pour appliquer des changements à chaud et conserver le PIN, utilisez le panneau.

L’installation d’une nouvelle version du Studio peut nécessiter un redémarrage : attendez la fin des exécutions, car `npm run stop` les interrompt. Une fois cette version lancée, les changements LAN, Tailscale, PIN et permissions depuis les préférences s’appliquent sans redémarrage. Fermer un onglet laisse les agents travailler.
