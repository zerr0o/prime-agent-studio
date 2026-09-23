# Computer Use

[English](en/computer-use.md) · [Documentation](../README.fr.md#documentation)

Computer Use est un mode expert pour le **vrai bureau Windows**. Une fois activé pour une conversation, son agent peut observer l’écran, changer d’application et utiliser la souris et le clavier. Il utilise l’agent et le modèle existants, sans session de bureau distant distincte ni machine virtuelle.

## Activer et arrêter

1. Ouvrez une conversation du projet et choisissez un modèle capable de lire les images.
2. Cochez **Autoriser le Computer Use** dans la zone de rédaction, à côté de **Autoriser les questions**. La case est décochée par défaut. Pour une nouvelle conversation, ce choix prend effet à l’envoi du premier message.
3. Donnez une tâche concrète à l’agent. Aucune validation supplémentaire n’est demandée pour chaque application ou clic.
4. Utilisez la commande distincte **Arrêter le bureau**, ou **Ctrl+Alt+Shift+F10**, pour arrêter le contrôle du bureau. Cela n’arrête pas le Studio et n’annule pas les autres exécutions d’agents.

Le mode est désactivé par défaut et n’est pas restauré après un redémarrage du serveur. Une conversation peut conserver son choix entre ses tours dans le même processus serveur. L’arrêt supprime l’autorisation de contrôle active. Un seul contrôleur peut utiliser le bureau partagé à la fois. L’accès distant en lecture seule ne peut ni l’activer ni l’arrêter.

## Capacités de l’agent

- Lister les fenêtres visibles, mettre une application au premier plan et attendre l’apparition d’une fenêtre après un lancement.
- Observer le bureau, le rectangle visible d’une fenêtre ou une zone de l’écran.
- Déplacer le pointeur, cliquer, double-cliquer, glisser, faire défiler, utiliser des raccourcis clavier et saisir du texte Unicode.
- Observer à nouveau pour vérifier le résultat avant de continuer.

Les outils natifs sont `computer_status`, `computer_windows`, `computer_observe`, `computer_act` et `computer_release`. Les outils ne peuvent pas activer le mode eux-mêmes. L’agent principal et ses sous-agents natifs partagent l’autorisation de la conversation et le même contrôleur du bureau.

`computer_observe` transmet une véritable image au modèle, avec ses dimensions et un identifiant de capture. Les actions utilisent les coordonnées de cette image. Le Studio les convertit en pixels physiques de l’écran, y compris pour les captures réduites et les moniteurs à origine négative. Chaque lot d’actions nécessite une observation récente. Si une action expire, l’agent doit observer l’état actuel au lieu de la répéter à l’aveugle. Chaque capture est un instantané qui peut montrer une interface en cours de chargement, pas une interface stabilisée.

Après le lancement d’une application, attendez sa fenêtre avec `computer_windows` (`action: "wait"`), mettez la au premier plan si besoin (`action: "focus"`), puis observez cette fenêtre avant de conclure. L’attente est en lecture seule, bornée et annulable : elle ne met jamais une fenêtre au premier plan, ne lance rien et ne capture rien. Les filtres `processName` (comparaison exacte insensible à la casse, suffixe `.exe` accepté), `title` (sous chaîne insensible à la casse) et `windowId` se combinent avec AND, et au moins un filtre non vide est requis. `timeoutMs` accepte un entier de 100 à 20000, 10000 par défaut. La réponse contient `found`, `timedOut`, `window` en cas de succès, la liste `windows`, `elapsedMs` et `note`. `found` signifie que la fenêtre existe, pas que l’interface ou le son sont prêts. `timedOut` signifie qu’elle n’a pas été vue dans le budget, pas que l’application a échoué. Si le focus change, observez à nouveau au lieu de relancer l’application ou d’agir depuis une image périmée.

`computer_act` accepte `observeAfter` et `observeOptions` (`windowId`, `region`, `maxWidth`) pour cadrer la vérification. Par défaut la vérification reprend les options de la capture d’origine ; `observeOptions: {}` demande tout le bureau. Une nouvelle fenêtre peut apparaître sur un autre écran, donc préférez `wait` puis `observe` de la nouvelle fenêtre avant d’agir dessus. Chaque résultat porte `applicationState: "unverified"` car une entrée envoyée n’est pas la réussite de la tâche. Si la capture de vérification échoue après une entrée réussie, le résultat garde `executed` plus `observationError: {code, message}` sans échec global ni rejeu ; observez à nouveau au lieu de rejouer le lot.

## Conséquences sur le vrai bureau

Ce mode n’est pas une frontière d’isolation. Les actions touchent vos applications ouvertes, fichiers, comptes et boîtes de dialogue. Les images peuvent contenir des informations privées et sont transmises au fournisseur du modèle choisi dans la conversation de l’agent. Les règles habituelles de conservation du fournisseur et des conversations natives s’appliquent. Les requêtes ordinaires de statut ne contiennent pas les pixels des captures.

N’utilisez pas la souris ou le clavier en même temps que l’agent. Gardez les fenêtres sensibles hors de la zone capturée. L’arrêt intervient au mieux pour les actions déjà envoyées : il ne peut pas annuler un clic, un envoi ou une opération sur un fichier déjà exécutés.

## Prérequis et limites Windows

- Windows et un bureau interactif déverrouillé sont nécessaires. Les autres systèmes signalent la fonction comme indisponible.
- L’exécuteur natif utilise Windows PowerShell et .NET. Aucun paquet d’automatisation supplémentaire ni serveur MCP n’est nécessaire.
- Les limites de privilèges Windows restent applicables. Le bureau sécurisé UAC et les applications plus privilégiées ne sont pas contournés. Le Studio ne s’élève pas automatiquement.
- Une observation de fenêtre capture les pixels visibles de l’écran, pas la surface interne d’une application masquée ou minimisée. Une fenêtre superposée peut donc apparaître sur l’image.
- Un changement d’écran ou de focus peut invalider une observation. L’agent doit observer à nouveau lorsque cela lui est demandé.
- Le raccourci dépend de son enregistrement réussi par l’exécuteur natif. La commande d’arrêt distincte du Studio reste également disponible.

## Développement et validation

Le pilote Node démarre son exécuteur natif masqué à la demande. Un gestionnaire lié aux sessions détient les autorisations et les captures. Un pont natif privé rattache les appels d’outils à la véritable exécution et au registre des sous-agents natifs. L’extension transmet les images par le circuit existant des fournisseurs.

```sh
npm run test:computer-use
npm run test:computer-use:ui
npm run test:computer-use:native
npm run test:computer-use:worker
```

Les vérifications automatisées utilisent un faux pilote de bureau et des images synthétiques. Le test d’intégration d’agent natif utilise le moteur installé, un fournisseur local déterministe, des données temporaires et des processus isolés. Ces vérifications ne capturent pas le bureau personnel, ne déplacent pas le vrai pointeur et ne font pas d’appels payants à un modèle. Elles ne remplacent pas un essai coordonné sur le vrai bureau pour les entrées, la mise à l’échelle des moniteurs, les restrictions de focus Windows et le raccourci global.

Consultez le guide de [développement](development.md) pour l’environnement du projet.
