# Computer Use

[English](en/computer-use.md) · [Documentation](../README.fr.md#documentation)

Computer Use est un mode expert pour le **vrai bureau Windows**. Son activation autorise l’agent principal à déléguer les tâches de bureau à des sous-agents natifs ordinaires. L’agent principal garde son modèle et son niveau de réflexion. Il n’y a ni session de bureau distant distincte ni machine virtuelle.

## Activer et arrêter

1. Ouvrez une conversation du projet. Choisissez un **Modèle de décision Computer Use** capable de lire les images dans les Préférences si le modèle principal ne le permet pas.
2. Cochez **Autoriser le Computer Use** dans la zone de rédaction, à côté de **Autoriser les questions**. La case est décochée par défaut. Pour une nouvelle conversation, ce choix prend effet à l’envoi du premier message.
3. Donnez une tâche concrète à l’agent. Un sous-agent est créé ou réutilisé uniquement si le bureau est nécessaire. Cocher la case ne crée aucun sous-agent et ne démarre aucun pilote de bureau. Aucune validation supplémentaire n’est demandée pour chaque application ou clic.
4. Utilisez la commande distincte **Arrêter Computer Use**, ou **Ctrl+Alt+Shift+F10**, pour arrêter le contrôle du bureau. Cela n’arrête pas le Studio et n’annule pas les autres exécutions d’agents.

Le mode est désactivé par défaut et n’est pas restauré après un redémarrage du serveur. Une conversation peut conserver son autorisation entre ses tours dans le même processus serveur. Plusieurs conversations peuvent être autorisées, mais un seul agent précis peut contrôler le bureau partagé à la fois. **Arrêter Computer Use** supprime toutes les autorisations et arrête le contrôleur actif. Décocher une conversation révoque uniquement son autorisation, sans interrompre un contrôleur étranger. L’accès distant en lecture seule ne peut ni l’activer ni l’arrêter.

## Moteur natif Windows

Computer Use utilise uniquement notre exécuteur Windows PowerShell/.NET. Il prend en charge le bureau multi-écrans, les régions et le focus natif. Aucun moteur externe ni téléchargement de pilote supplémentaire n’est nécessaire.

Une autorisation n’acquiert pas le bureau et ne démarre aucun pilote. Si la libération du contrôleur ne peut pas être vérifiée, tout nouveau contrôle reste bloqué. Utilisez Arrêter pour réessayer ; une autorisation désactivée ne prouve pas à elle seule que le nettoyage est terminé.

## Modèle de décision Computer Use

**Préférences > Outils > Modèle de décision Computer Use** choisit le modèle du **sous-agent qui effectue la tâche de bureau**, jamais celui de la conversation principale. **Identique à la conversation** utilise le même modèle dans un sous-agent distinct. Un modèle nommé remplace les réglages généraux des sous-agents uniquement pour les tâches de bureau.

La liste vient du même catalogue que le sélecteur principal. Le modèle de bureau doit lire les images. Avant de lui accorder l’accès, le Studio vérifie le modèle dans sa session native et la prise en charge des images dans le catalogue. Un modèle incorrect ou non compatible ne peut pas acquérir le bureau ; le Studio ne le remplace jamais silencieusement. Un agent principal textuel peut donc déléguer à un modèle Computer Use capable de lire les images.

Le sélecteur **Réflexion** s’applique uniquement au sous-agent de bureau. **Identique à la conversation** reprend le niveau de la conversation pour cet enfant, sans modifier les réglages de l’agent principal.

L’agent principal utilise les mécanismes existants `rlm.spawn` et `agent_message`. Il peut réutiliser un enfant inactif avec son contexte ou en créer un nouveau pour une autre tâche. Il n’y a ni spécialiste automatique par conversation, ni rôle obligatoire, ni nom réservé. L’enfant transmet un résultat ou un blocage ; les captures restent dans sa propre conversation sauf partage explicite. La réutilisation peut préserver le cache du fournisseur, sans garantie de cache utilisé ni de gain de vitesse.

## Fiabilité des images et du focus

Les nouvelles captures tiennent dans **2000 × 2000 pixels**, en conservant leurs proportions et les métadonnées de coordonnées, même si `maxWidth` demande davantage. Cette limite couvre aussi les écrans en portrait. Elle évite la limite d’images signalée par Opus dans les requêtes contenant beaucoup d’images, sans dépendre de la tolérance d’un autre fournisseur.

Les anciennes captures Computer Use trop grandes sont omises uniquement du contexte temporaire envoyé au modèle, avec une consigne de nouvelle observation. Leurs pixels ne sont pas redimensionnés en gardant d’anciennes coordonnées. Les conversations enregistrées et les autres images de l’utilisateur restent inchangées.

Le moteur natif attend brièvement la restauration d’une fenêtre minimisée et effectue des tentatives natives de focus bornées. Il vérifie la fenêtre réellement au premier plan. Windows peut encore refuser l’activation ou l’accès à une fenêtre plus privilégiée ; l’erreur identifie la cible et la fenêtre au premier plan au lieu d’annoncer un succès. Aucun contournement par élévation ou Win+R n’est utilisé.

## Capacités de l’agent

- Lister les fenêtres visibles, mettre une application au premier plan et attendre l’apparition d’une fenêtre après un lancement.
- Observer le bureau, le rectangle visible d’une fenêtre ou une zone de l’écran.
- Déplacer le pointeur, cliquer, double-cliquer, glisser, faire défiler, utiliser des raccourcis clavier et saisir du texte Unicode.
- Observer à nouveau pour vérifier le résultat avant de continuer.

Les outils natifs sont `computer_status`, `computer_windows`, `computer_observe`, `computer_act` et `computer_release`. Les outils ne peuvent pas activer le mode eux-mêmes. L’agent principal délègue le travail de bureau au lieu de le piloter. Les enfants natifs héritent de l’autorisation de la conversation, **pas du verrou du bureau**. Le premier outil de bureau acquiert ce verrou pour l’enfant précis ; les frères et les agents des autres conversations reçoivent un refus pour bureau occupé. `computer_status` n’acquiert pas le verrou et ne démarre aucun pilote. Le verrou est libéré lorsque l’enfant termine, s’arrête, est supprimé ou appelle `computer_release` ; les anciennes captures sont invalidées. Un refus d’outil récupérable ne donne pas le contrôle à un autre agent. Réutiliser un enfant exige une nouvelle acquisition et une observation fraîche.

`computer_observe` transmet une véritable image au modèle, avec ses dimensions et un identifiant de capture. Les actions utilisent les coordonnées de cette image. Le Studio les convertit en pixels physiques de l’écran, y compris pour les captures réduites et les moniteurs à origine négative. Chaque lot d’actions nécessite une observation récente. Si une action expire, l’agent doit observer l’état actuel au lieu de la répéter à l’aveugle. Chaque capture est un instantané qui peut montrer une interface en cours de chargement, pas une interface stabilisée.

Après le lancement d’une application, attendez sa fenêtre avec `computer_windows` (`action: "wait"`), mettez la au premier plan si besoin (`action: "focus"`), puis observez cette fenêtre avant de conclure. L’attente est en lecture seule, bornée et annulable : elle ne met jamais une fenêtre au premier plan, ne lance rien et ne capture rien. Les filtres `processName` (comparaison exacte insensible à la casse, suffixe `.exe` accepté), `title` (sous chaîne insensible à la casse) et `windowId` se combinent avec AND, et au moins un filtre non vide est requis. `timeoutMs` accepte un entier de 100 à 20000, 10000 par défaut. La réponse contient `found`, `timedOut`, `window` en cas de succès, la liste `windows`, `elapsedMs` et `note`. `found` signifie que la fenêtre existe, pas que l’interface ou le son sont prêts. `timedOut` signifie qu’elle n’a pas été vue dans le budget, pas que l’application a échoué. Si le focus change, observez à nouveau au lieu de relancer l’application ou d’agir depuis une image périmée.

`computer_act` accepte `observeAfter` et `observeOptions` (`windowId`, `region`, `maxWidth`) pour cadrer la vérification. Par défaut la vérification reprend les options de la capture d’origine ; `observeOptions: {}` demande tout le bureau. Une nouvelle fenêtre peut apparaître sur un autre écran, donc préférez `wait` puis `observe` de la nouvelle fenêtre avant d’agir dessus. Chaque résultat porte `applicationState: "unverified"` car une entrée envoyée n’est pas la réussite de la tâche. Si la capture de vérification échoue après une entrée réussie, le résultat garde `executed` plus `observationError: {code, message}` sans échec global ni rejeu ; observez à nouveau au lieu de rejouer le lot.

## Bordure d’activité

Une bordure orange avec un fondu intérieur apparaît sur chaque écran lorsque le worker natif détient le bureau. Elle ne prend pas le focus et laisse passer les clics. Elle disparaît à l’arrêt ou à la fermeture du worker ; une simple autorisation ne l’affiche pas.

Windows doit confirmer l’exclusion des captures (`WDA_EXCLUDEFROMCAPTURE`) avant tout affichage. Si cette protection est indisponible, la bordure reste cachée et `computer_status` expose le diagnostic dans `driver.overlay`. Le contrôle natif reste disponible. La bordure n’est pas une protection contre un logiciel tiers de capture.

## Conséquences sur le vrai bureau

Ce mode n’est pas une frontière d’isolation. Les actions touchent vos applications ouvertes, fichiers, comptes et boîtes de dialogue. Les images peuvent contenir des informations privées et sont transmises au fournisseur du modèle choisi dans la conversation de l’agent. Les règles habituelles de conservation du fournisseur et des conversations natives s’appliquent. Les requêtes ordinaires de statut ne contiennent pas les pixels des captures.

N’utilisez pas la souris ou le clavier en même temps que l’agent. Gardez les fenêtres sensibles hors de la zone capturée. L’arrêt intervient au mieux pour les actions déjà envoyées : il ne peut pas annuler un clic, un envoi ou une opération sur un fichier déjà exécutés.

## Prérequis et limites Windows

- Windows et un bureau interactif déverrouillé sont nécessaires. Les autres systèmes signalent la fonction comme indisponible.
- L’exécuteur utilise Windows PowerShell et .NET. Aucun serveur MCP à configurer séparément.
- Les limites de privilèges Windows restent applicables. Le bureau sécurisé UAC et les applications plus privilégiées ne sont pas contournés. Le Studio ne s’élève pas automatiquement.
- Une observation de fenêtre capture les pixels visibles de l’écran, pas la surface interne d’une application masquée ou minimisée. Une fenêtre superposée peut donc apparaître sur l’image.
- Un changement d’écran ou de focus peut invalider une observation. L’agent doit observer à nouveau lorsque cela lui est demandé.
- Le raccourci dépend de son enregistrement réussi par l’exécuteur natif. La commande d’arrêt distincte du Studio reste également disponible.

## Développement et validation

Le pilote Node démarre son exécuteur natif masqué à la demande. Le gestionnaire sépare les autorisations des conversations du détenteur global, identifié par exécution, agent et session native. Un pont natif privé vérifie la filiation dans le registre des sous-agents et le modèle dans la branche sélectionnée de la session et le catalogue ; les indications de modèle des requêtes d’outils ne peuvent pas accorder un accès. L’extension transmet les images par le circuit existant des fournisseurs.

La preuve de délégation couvre un tour ordinaire avec Computer Use activé mais sans enfant ni pilote, un vrai enfant natif, la propriété exclusive, la libération automatique et la réutilisation du même enfant avec une nouvelle capture. Elle utilise uniquement un fournisseur local et un faux bureau. Cette évolution ne résout pas tous les problèmes de fenêtres temporaires, d’actions natives partielles ou de rétention des anciennes captures ; les protections de focus, d’annulation et d’absence de rejeu restent actives.

```sh
npm run test:computer-use
npm run test:computer-use:ui
npm run test:computer-use:native
npm run test:computer-use:worker
powershell.exe -NoProfile -NonInteractive -File runtime/computer-use-overlay.selftest.ps1
```

Les vérifications automatisées utilisent un faux pilote de bureau et des images synthétiques. Le test d’intégration d’agent natif utilise le moteur installé, un fournisseur local déterministe, des données temporaires et des processus isolés. Ces vérifications ne capturent pas le bureau personnel, ne déplacent pas le vrai pointeur et ne font pas d’appels payants à un modèle. Elles ne remplacent pas un essai coordonné sur le vrai bureau pour les entrées, la mise à l’échelle des moniteurs, les restrictions de focus Windows et le raccourci global.

Consultez le guide de [développement](development.md) pour l’environnement du projet.
