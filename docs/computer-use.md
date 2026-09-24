# Computer Use

[English](en/computer-use.md) · [Documentation](../README.fr.md#documentation)

Computer Use est un mode expert pour le **vrai bureau Windows**. Une fois activé pour une conversation, son agent peut observer l’écran, changer d’application et utiliser la souris et le clavier. Il utilise l’agent et le modèle existants, sans session de bureau distant distincte ni machine virtuelle.

## Activer et arrêter

1. Ouvrez une conversation du projet et choisissez un modèle capable de lire les images.
2. Cochez **Autoriser le Computer Use** dans la zone de rédaction, à côté de **Autoriser les questions**. La case est décochée par défaut. Pour une nouvelle conversation, ce choix prend effet à l’envoi du premier message.
3. Donnez une tâche concrète à l’agent. Aucune validation supplémentaire n’est demandée pour chaque application ou clic.
4. Utilisez la commande distincte **Arrêter le bureau**, ou **Ctrl+Alt+Shift+F10**, pour arrêter le contrôle du bureau. Cela n’arrête pas le Studio et n’annule pas les autres exécutions d’agents.

Le mode est désactivé par défaut et n’est pas restauré après un redémarrage du serveur. Une conversation peut conserver son choix entre ses tours dans le même processus serveur. L’arrêt supprime l’autorisation de contrôle active. Un seul contrôleur peut utiliser le bureau partagé à la fois. L’accès distant en lecture seule ne peut ni l’activer ni l’arrêter.

## Choisir un moteur global

Ouvrez **Préférences > Outils > Bureau expert**. Le moteur est un réglage global unique pour ce PC, enregistré côté serveur :

- **Intégration originale (Windows)** est le choix par défaut. Elle utilise notre exécuteur PowerShell/.NET et prend en charge le bureau multi-écrans complet, les régions et le focus natif.
- **Cua Driver (beta)** utilise la version **0.28.2** Windows x64, dans des processus privés du Studio. Elle ajoute l’inspection d’accessibilité des fenêtres et les actions ciblées par élément. Elle ne remplace ni l’agent ni le modèle et ne demande pas de connexion MCP à configurer.

Choisir un moteur n’active pas le contrôle. Le changement demande un bureau éteint et sans contrôleur : la zone reste verrouillée tant que Computer Use est actif, en nettoyage ou en échec de nettoyage. Un moteur indisponible affiche la raison ; le Studio ne bascule jamais silencieusement vers l’autre et ne rejoue pas une action. L’ancienne sélection par session a disparu : toutes les conversations utilisent le même moteur global. La garde native Windows conserve l’exclusivité du bureau et le raccourci d’arrêt avec CUA. CUA refuse de démarrer si ce raccourci n’est pas enregistré. Si l’arrêt des processus ou la libération des entrées ne peut pas être vérifié, tout nouveau contrôle reste bloqué. Utilisez Arrêter pour réessayer ; une autorisation désactivée ne prouve pas à elle seule que le nettoyage est terminé.

## Modèle de décision Computer Use

**Préférences > Outils > Modèle de décision Computer Use** choisit le modèle des exécutions avec bureau autorisé. La valeur par défaut **Identique à la conversation** garde le modèle de la conversation. Un modèle nommé remplace ce modèle au démarrage de l’exécution, uniquement pour les tours avec Computer Use autorisé.

La liste vient du même catalogue que le sélecteur principal, dans le même menu que le sélecteur de modèle de la conversation. Les modèles qui lisent les images sont exigés : un modèle sans images est refusé à l’enregistrement comme au démarrage, sans bascule silencieuse. Un modèle indisponible est refusé lui aussi. L’extension fournit les outils de bureau à l’agent de l’exécution autorisée. Le réglage natif `imageModel` traite les tours avec images des modèles texte, sans créer d’agent distinct d’analyse des captures. Ce réglage reste donc une substitution au niveau de l’exécution, pas un sous-système de vision séparé.

Le sélecteur **Réflexion** à côté du modèle reprend les mêmes niveaux que le sélecteur de la conversation (**Identique à la conversation** par défaut). Quand il est réglé, ce niveau s’applique aux exécutions avec bureau autorisé exactement comme le niveau de la conversation, même si le modèle reste celui de la conversation. Sinon, le niveau de la conversation est conservé.

Les actions par pixels de CUA sont plus limitées dans cette beta. Préférez un `windowId` précis. Les images de fenêtres complètes sont prises en charge, mais pas les captures de régions. La capture du bureau couvre l’écran principal à sa résolution native ; si une dimension dépasse 2000 pixels, choisissez une fenêtre. `maxWidth` limite le grand côté des images de fenêtres CUA, mais ne réduit pas le bureau. Les glissés à plusieurs segments et les déplacements du pointeur propres à une fenêtre sont refusés, pas approximés. Un refus de focus n’autorise pas à relancer l’application.

`computer_inspect` lit l’arbre d’accessibilité d’une fenêtre CUA sans capture d’écran. Il renvoie une liste bornée d’éléments et un `frameId` d’accessibilité. Utilisez l’`elementId` retourné dans `computer_act`, ou `set_value` avec `elementId` et `value` pour un champ éditable. Une valeur vide efface le champ. Ces observations n’ont pas de coordonnées en pixels. Les captures de fenêtres incluent aussi les éléments d’accessibilité disponibles.

Par défaut, les actions CUA par pixels passent au premier plan ; les actions ciblées par élément utilisent l’arrière-plan. Le paramètre de lot `deliveryMode` permet de choisir `foreground` ou `background`. Un refus ne provoque aucun changement automatique de mode. Inspectez ou observez à nouveau après un lot. Les résultats peuvent être partiels, refusés ou invérifiables ; `executed` et une entrée transmise ne prouvent pas la réussite de la tâche. Aucun gain de vitesse global par rapport au backend original n’est établi.

## Fiabilité des images et du focus

Les nouvelles captures tiennent dans **2000 × 2000 pixels**, en conservant leurs proportions et les métadonnées de coordonnées, même si `maxWidth` demande davantage. Cette limite couvre aussi les écrans en portrait. Elle évite la limite d’images signalée par Opus dans les requêtes contenant beaucoup d’images, sans dépendre de la tolérance d’un autre fournisseur.

Les anciennes captures Computer Use trop grandes sont omises uniquement du contexte temporaire envoyé au modèle, avec une consigne de nouvelle observation. Leurs pixels ne sont pas redimensionnés en gardant d’anciennes coordonnées. Les conversations enregistrées et les autres images de l’utilisateur restent inchangées.

Le backend original attend brièvement la restauration d’une fenêtre minimisée et effectue des tentatives natives de focus bornées. Il vérifie la fenêtre réellement au premier plan. Windows peut encore refuser l’activation ou l’accès à une fenêtre plus privilégiée ; l’erreur identifie la cible et la fenêtre au premier plan au lieu d’annoncer un succès. Aucun contournement par élévation ou Win+R n’est utilisé.

## Capacités de l’agent

- Lister les fenêtres visibles, mettre une application au premier plan et attendre l’apparition d’une fenêtre après un lancement.
- Observer le bureau, le rectangle visible d’une fenêtre ou une zone de l’écran.
- Déplacer le pointeur, cliquer, double-cliquer, glisser, faire défiler, utiliser des raccourcis clavier et saisir du texte Unicode.
- Observer à nouveau pour vérifier le résultat avant de continuer.

Les outils natifs sont `computer_status`, `computer_windows`, `computer_observe`, `computer_inspect`, `computer_act` et `computer_release`. Les capacités ci-dessous dépendent du backend choisi. Les outils ne peuvent pas activer le mode eux-mêmes. L’agent principal et ses sous-agents natifs partagent l’autorisation de la conversation et le même contrôleur du bureau.

`computer_observe` transmet une véritable image au modèle, avec ses dimensions et un identifiant de capture. Les actions utilisent les coordonnées de cette image. Avec le backend original, le Studio les convertit en pixels physiques de l’écran, y compris pour les captures réduites et les moniteurs à origine négative. CUA conserve son propre espace de coordonnées lié à l’observation. Chaque lot d’actions nécessite une observation récente. Si une action expire, l’agent doit observer l’état actuel au lieu de la répéter à l’aveugle. Chaque capture est un instantané qui peut montrer une interface en cours de chargement, pas une interface stabilisée.

Après le lancement d’une application, attendez sa fenêtre avec `computer_windows` (`action: "wait"`), mettez la au premier plan si besoin (`action: "focus"`), puis observez cette fenêtre avant de conclure. L’attente est en lecture seule, bornée et annulable : elle ne met jamais une fenêtre au premier plan, ne lance rien et ne capture rien. Les filtres `processName` (comparaison exacte insensible à la casse, suffixe `.exe` accepté), `title` (sous chaîne insensible à la casse) et `windowId` se combinent avec AND, et au moins un filtre non vide est requis. `timeoutMs` accepte un entier de 100 à 20000, 10000 par défaut. La réponse contient `found`, `timedOut`, `window` en cas de succès, la liste `windows`, `elapsedMs` et `note`. `found` signifie que la fenêtre existe, pas que l’interface ou le son sont prêts. `timedOut` signifie qu’elle n’a pas été vue dans le budget, pas que l’application a échoué. Si le focus change, observez à nouveau au lieu de relancer l’application ou d’agir depuis une image périmée.

`computer_act` accepte `observeAfter` et `observeOptions` (`windowId`, `region`, `maxWidth`) pour cadrer la vérification. Par défaut la vérification reprend les options de la capture d’origine ; `observeOptions: {}` demande tout le bureau. Une nouvelle fenêtre peut apparaître sur un autre écran, donc préférez `wait` puis `observe` de la nouvelle fenêtre avant d’agir dessus. Chaque résultat porte `applicationState: "unverified"` car une entrée envoyée n’est pas la réussite de la tâche. Si la capture de vérification échoue après une entrée réussie, le résultat garde `executed` plus `observationError: {code, message}` sans échec global ni rejeu ; observez à nouveau au lieu de rejouer le lot.

## Conséquences sur le vrai bureau

Ce mode n’est pas une frontière d’isolation. Les actions touchent vos applications ouvertes, fichiers, comptes et boîtes de dialogue. Les images peuvent contenir des informations privées et sont transmises au fournisseur du modèle choisi dans la conversation de l’agent. Les règles habituelles de conservation du fournisseur et des conversations natives s’appliquent. Les requêtes ordinaires de statut ne contiennent pas les pixels des captures.

N’utilisez pas la souris ou le clavier en même temps que l’agent. Gardez les fenêtres sensibles hors de la zone capturée. L’arrêt intervient au mieux pour les actions déjà envoyées : il ne peut pas annuler un clic, un envoi ou une opération sur un fichier déjà exécutés.

## Prérequis et limites Windows

- Windows et un bureau interactif déverrouillé sont nécessaires. Les autres systèmes signalent la fonction comme indisponible.
- L’exécuteur original utilise Windows PowerShell et .NET. CUA est distribué pour Windows x64 avec sa licence MIT et des sommes de contrôle. Aucun des deux modes ne demande de serveur MCP à configurer séparément.
- Les limites de privilèges Windows restent applicables. Le bureau sécurisé UAC et les applications plus privilégiées ne sont pas contournés. Le Studio ne s’élève pas automatiquement.
- Avec le backend original, une observation de fenêtre capture les pixels visibles de l’écran, pas la surface interne d’une application masquée ou minimisée. Une fenêtre superposée peut donc apparaître sur l’image.
- Un changement d’écran ou de focus peut invalider une observation. L’agent doit observer à nouveau lorsque cela lui est demandé.
- Le raccourci dépend de son enregistrement réussi par l’exécuteur natif. La commande d’arrêt distincte du Studio reste également disponible.

## Développement et validation

Le pilote Node démarre son exécuteur natif masqué à la demande. Un gestionnaire lié aux sessions détient les autorisations et les captures. Un pont natif privé rattache les appels d’outils à la véritable exécution et au registre des sous-agents natifs. L’extension transmet les images par le circuit existant des fournisseurs.

Pour préparer les fichiers CUA dans un checkout de développement, lancez `npm run cua:prepare`. La commande vérifie une archive en cache ou télécharge la version figée, prépare le pilote et sa licence, mais ne l’exécute jamais. Les builds Windows x64 exigent ces fichiers vérifiés ; les autres plateformes ne les embarquent pas.

```sh
npm run test:computer-use
npm run test:cua
npm run test:computer-use:ui
npm run test:computer-use:native
npm run test:computer-use:worker
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File runtime/computer-use-worker.ps1 -JobSelfTest
node scripts/test-cua-job-adoption.mjs --mode=both
```

Les contrôles Windows Job utilisent uniquement des processus de test privés. Ils n’initialisent ni capture, ni entrée, ni focus, ni raccourci global du bureau.

Les vérifications automatisées utilisent un faux pilote de bureau et des images synthétiques. Le test d’intégration d’agent natif utilise le moteur installé, un fournisseur local déterministe, des données temporaires et des processus isolés. Ces vérifications ne capturent pas le bureau personnel, ne déplacent pas le vrai pointeur et ne font pas d’appels payants à un modèle. Elles ne remplacent pas un essai coordonné sur le vrai bureau pour les entrées, la mise à l’échelle des moniteurs, les restrictions de focus Windows et le raccourci global.

Consultez le guide de [développement](development.md) pour l’environnement du projet.
