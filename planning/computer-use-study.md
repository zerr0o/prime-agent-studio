# Étude : Computer Use dans Prime Agent Studio

Date de consultation : 22 septembre 2026. Statut : proposition, non implémentée.
Base examinée : Prime Agent Studio 3.9.0-beta.1, commit `3c0c3518a8b9d41339ff4fde8c7f89e14e52a304`. Contrats d’images vérifiés séparément dans le moteur installé Prime Agent 0.9.5 ; leur compatibilité avec les autres versions livrées devra être testée.

## 1. Recommandation

**Construire un mode expert qui pilote directement le bureau réel, activable à la demande.** L’utilisateur professionnel choisit de confier la souris et le clavier à l’agent. La priorité est la puissance, la fluidité et la qualité d’exécution, pas la construction d’un environnement isolé.

Cadrage corrigé après la demande explicite de l’utilisateur : pas de VM, pas de sandbox dédiée, pas de liste restrictive d’applications et pas de confirmation systématique à chaque clic ou changement de fenêtre. Ces éléments ne sont ni un préalable au prototype ni un objectif de la V1.

Conserver la boucle d’agents native de Studio et ajouter des outils de capture et d’action sur Windows. Une extension native Studio est le premier adaptateur recommandé ; un skill Python peut faciliter les séquences programmées et un adaptateur MCP peut suivre. Les opérations doivent fonctionner sur les applications réelles et permettre les workflows entre plusieurs applications.

Garder l’activation/désactivation explicite, l’arrêt immédiat, la vérification des coordonnées et un seul agent aux commandes à un instant donné : ce sont des mécanismes d’usage et de fiabilité. Aucun contrôle du bureau n’est lancé dans le cadre de cette étude.

## 2. Ce qu’OpenAI propose réellement

| Offre                                                       | Environnement piloté                               | Distinction utile                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Computer Use dans l’application ChatGPT, avec Work ou Codex | Applications locales macOS et Windows              | Installation d’un plugin, serveur MCP et skill, permissions par application. [S1]                             |
| Navigateur intégré à l’application                          | Profil navigateur séparé du navigateur habituel    | Contrôle de pages, captures, permissions de sites ; CDP soumis à un accès explicite en mode développeur. [S2] |
| Agent / Work sur le web ou mobile                           | Navigateur sur un ordinateur distant dans le cloud | Ce n’est pas le contrôle direct de la souris du PC de l’utilisateur. [S2]                                     |
| API Computer Use                                            | Environnement fourni par le développeur            | OpenAI fournit les décisions du modèle, pas un service qui prend directement la souris du client. [S3, S4]    |

### Windows et macOS ne sont pas équivalents

La documentation produit actuelle est explicite : sous Windows, Computer Use utilise le bureau actif, déplace le pointeur et saisit au premier plan. L’utilisateur ne peut pas continuer à utiliser librement la même session pendant l’exécution. La fenêtre cible doit rester visible. OpenAI propose notamment une VM pour déplacer cette prise de contrôle hors du bureau principal. [S1]

Sur macOS, l’utilisation en arrière-plan est documentée. Les permissions Screen Recording et Accessibility sont nécessaires. Un mode de fonctionnement après verrouillage existe avec des protections spécifiques à macOS. Cela ne constitue pas une recette Windows, et nous ne devons pas promettre ce comportement dans Studio. [S1]

Le code complet du service de bureau utilisé en production par Codex n’est pas décrit dans les sources consultées. La documentation et l’exemple public permettent de reproduire le principe, pas d’affirmer une reproduction exacte de ses mécanismes internes.

### Autorisations du produit

OpenAI distingue l’autorisation système, l’autorisation d’utiliser une application et l’approbation d’une action sensible. Le produit permet de mémoriser certaines applications autorisées. Les politiques administrateur peuvent imposer des restrictions. Le contrôle de terminaux, du produit lui-même, de l’authentification administrateur et des demandes de permissions de sécurité est bloqué dans le Computer Use local documenté. [S1, S5]

Ces protections ne sont pas fournies automatiquement lorsqu’un développeur branche l’API à son propre exécuteur.

## 3. Fonctionnement technique

La boucle de base comporte cinq étapes :

1. **Observer** : capturer l’application ou l’écran ciblé et identifier la fenêtre, la taille de l’image et l’état courant.
2. **Décider** : le modèle interprète la capture avec la consigne et l’historique. Des éléments structurés peuvent compléter la vision.
3. **Préparer** : vérifier que le mode est actif, que l’agent a le contrôle et que les coordonnées correspondent à l’état actuel.
4. **Agir** : l’exécuteur local clique, saisit ou fait défiler. Le modèle ne manipule pas lui-même le matériel.
5. **Vérifier** : reprendre une capture et contrôler le résultat réel. Continuer, corriger ou demander une intervention.

Il s’agit de décisions successives, pas nécessairement d’un flux vidéo continu. Des captures après de petits groupes d’actions suffisent souvent. Le délai dépend principalement du modèle, de la résolution, des appels réseau et de l’application. Aucune mesure de latence ou de coût n’a été effectuée dans cette étude.

### Les deux interfaces documentées par l’API

**Actions structurées.** Avec l’outil `computer`, le modèle renvoie un `computer_call`, un `call_id` et un tableau ordonné `actions[]`. Les actions comprennent `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait` et `screenshot`. Notre exécuteur réalise les actions autorisées puis renvoie un `computer_call_output` contenant la capture correspondante. `previous_response_id` permet de continuer la conversation. [S3]

Un statut `completed` sur l’appel signifie que le modèle a fini de produire sa demande, pas que les clics ont été exécutés ni que la tâche a réussi.

**Code exécuté dans un environnement persistant.** Le modèle appelle une fonction comme `exec_py` ou `exec_js`. Elle exécute du code utilisant PyAutoGUI ou Playwright et renvoie du texte et des images. Des boucles et des vérifications locales peuvent réduire les allers-retours avec le modèle. La documentation actuelle recommande cette approche pour son modèle le plus récent. Elle exige toutefois de maîtriser l’environnement d’exécution. [S3, S4]

Une troisième possibilité de raccordement est de conserver nos propres outils de fonctions ou MCP. Le modèle n’a pas besoin de l’outil propriétaire `computer` pour utiliser ces opérations. L’API OpenAI avec MCP distant et le client MCP local du moteur Prime Agent sont deux chemins différents ; les formats et les validations ne doivent pas être confondus. [S4]

Les anciens tutoriels `computer-use-preview` utilisent un autre schéma, notamment une seule `action` au lieu de `actions[]`. Il faut choisir le contrat selon les capacités effectives du modèle et du fournisseur, pas recopier une intégration historique. [S4]

### Ce que montre l’exemple public OpenAI

Le dépôt MIT `openai/openai-cua-sample-app` fournit un agent JavaScript/Playwright et un agent Python/PyAutoGUI, une console, des scénarios et des traces. Lecture effectuée au commit `f2a3dc523ae406f9b704f9a420a05402a63b4522`. [S6]

Il montre une vraie boucle de modèle, un worker persistant, des délais maximaux, un arrêt et un processus séparé de libération des touches. Son README avertit expressément que le code généré tourne avec les droits de l’utilisateur et que l’exemple ne fournit ni sandbox système ni contrôles de production OpenAI. Les captures peuvent contenir d’autres fenêtres.

L’exemple est une référence de protocole et de reprise sur incident. Son absence de sandbox est documentée ; le périmètre expert demandé pour Studio n’exige pas d’en construire une avant de prototyper le contrôle du bureau réel.

## 4. Ce que Studio possède déjà

Les éléments ci-dessous ont été vérifiés dans les sources locales. Les numéros de ligne correspondent au commit indiqué en tête du document.

| Brique existante                                        | Sources locales                                                                                          | Réutilisation envisagée                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Sessions et boucle d’agents native, extensions d’outils | `lib/agent.mjs:738-809`, `runtime/studio-question-extension.mjs`, `runtime/studio-roadmap-extension.mjs` | Ajouter des outils de bureau sans recréer un orchestrateur ou modifier le moteur installé.                                     |
| Images et sélection de modèles visuels                  | `server.mjs:558-575`, `lib/images.mjs:6-78`, `lib/live-session-client.mjs`                               | Vérifier la capacité image du modèle ; compléter le trajet des observations produites par les outils.                          |
| Questions et réponses interactives                      | `lib/native-interactions.mjs`, `public/questions.js`, routes interactions dans `server.mjs`              | Réutiliser les questions si une information manque. Pas d’approbation systématique de chaque action dans le mode expert.       |
| Configuration MCP et noyau Python persistant            | `lib/mcp-config.mjs`, `lib/mcp-service.mjs`, `lib/kernel.mjs`, `runtime/kernel-bootstrap.mjs`            | Adaptateurs possibles ; aucun exécuteur de capture ou de saisie livré par ces modules actuellement.                            |
| Application Tauri et accès distant authentifié          | `src-tauri/src/main.rs:791-847`, `src-tauri/Cargo.toml`, `lib/lan.mjs:242-323`                           | Sélection de cible, commandes utilisateur, notifications et observation distante. Nouvelles capacités à ajouter explicitement. |

### Ce qui manque

Il n’y a pas d’exécuteur de capture, de clic ou de clavier dans la surface Tauri examinée. Les ajouts nécessaires sont cet exécuteur, l’activation du mode, la coordination entre agents, l’arrêt indépendant du modèle et un affichage lisible de l’activité.

Une autorisation par application ou un système d’approbation par action ne fait pas partie du périmètre expert demandé. Les questions interactives restent disponibles lorsqu’une information nécessaire à la tâche manque.

Les limites de `lib/images.mjs` concernent les images jointes par l’utilisateur : quatre images, 4 Mo par image et 8 Mo par message. Elles ne prouvent pas les limites des images renvoyées par un outil natif ou MCP. Ce trajet doit être testé séparément.

### Chemin des images issues d’outils

Une vérification en lecture seule du moteur installé **Prime Agent 0.9.5** confirme deux contrats de retour multimodal :

1. Un outil d’extension peut retourner directement `AgentToolResult.content: (TextContent | ImageContent)[]`. Les pixels sont destinés au modèle ; le champ `details` est séparé pour les journaux et l’interface.
2. Le skill `attach-image` émet une pièce jointe du noyau, convertie par `imageBlocksFromAttachments()` en `ImageContent`. Il refuse un modèle sans vision et peut redimensionner ou recompresser l’image. Il faut donc calculer les coordonnées à partir de l’image réellement présentée, pas seulement de la capture brute.

Sources installées : `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:294-304`, `dist/core/extensions/types.d.ts:676`, `dist/core/tools/ipython.d.ts:104-105`, `dist/core/kernel/shared.d.ts:132-137`, skill `attach-image`.

**Piège MCP identifié :** dans `dist/prime-agent-runtime/src/rlm/mcp_base.py`, `_parse_result` préfère le contenu structuré, puis le texte ; les autres blocs deviennent des dictionnaires Python seulement en l’absence de ces sorties. Un résultat MCP image n’est donc pas automatiquement une image vue par le modèle, et une réponse mixte texte/image nécessite une attention particulière. Utiliser un adaptateur explicite vers `ImageContent` ou `attach-image`, jamais un simple affichage JSON du base64.

Ces constats valident les contrats dans les sources, pas leur fonctionnement de bout en bout pour le futur outil. Le prototype doit encore couvrir RPC, headless, fournisseurs compatibles, reprise de session, historique et visualisation dans Studio. Les limites des pièces jointes du noyau et celles de l’upload utilisateur sont distinctes ; les limites d’un outil direct doivent être mesurées séparément.

## 5. Architecture proposée

```text
Activation du mode Computer Use dans Studio
                    |
Consigne utilisateur + agent existant + modèle visuel
                    |
       Extension native Computer Use
       (skill Python / MCP possibles)
                    |
       Exécuteur Windows local
       capture / fenêtres / souris / clavier
                    |
       Applications réelles du bureau
                    |
       Capture de vérification vers le modèle

Bouton Stop + raccourci global : arrêt sans attendre le modèle
```

### Comparaison des raccordements

| Option                                     | Avantage                                                            | Coût ou limite                                                       | Choix                                      |
| ------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Extension Studio + exécuteur local         | Retour d’images direct, sessions existantes, plusieurs fournisseurs | Nouveau contrat de bureau et packaging de l’exécuteur                | Premier raccordement produit recommandé    |
| Skill Python sur le même exécuteur         | Séquences, boucles, branches et helpers dans le noyau déjà présent  | Garantir le retour d’images, l’arrêt et la cohérence des coordonnées | Complément pour les workflows avancés      |
| MCP local + même exécuteur                 | Réutilisable dans d’autres clients                                  | Adaptateur d’images nécessaire dans le pont Python actuel            | Complément ultérieur                       |
| Boucle OpenAI dédiée avec outil `computer` | Contrat officiel d’actions                                          | Deuxième boucle, état et facturation API supplémentaires             | Seulement si les essais démontrent un gain |

Un serveur MCP en `stdio` ne peut pas appeler directement `tauri::invoke`. Deux implantations sont possibles : commandes Tauri avec un pont explicite, ou exécutable auxiliaire distribué avec Studio. Privilégier un exécuteur local séparé pour pouvoir l’arrêter et le relancer sans dépendre d’une réponse du modèle. Pour la démonstration initiale, un worker Python/PyAutoGUI est acceptable sur le bureau réel.

Réutiliser les connexions locales et distantes déjà authentifiées de Studio. Il n’est pas nécessaire de créer une nouvelle surface réseau publique ni de reconstruire un système d’approbation pour chaque action.

### Contrat minimal, à créer

Les noms suivants sont proposés, pas des outils déjà disponibles :

- `computer.observe` : capture de fenêtre, d’écran ou de région, avec `frameId`, horodatage, taille et transformation des coordonnées.
- `computer.windows` : lister les fenêtres, sélectionner une cible, activer, déplacer ou redimensionner selon les capacités Windows.
- `computer.act` : clic, double clic, déplacement, glisser-déposer, défilement, texte, touches et raccourcis, avec séquences d’actions possibles.
- `computer.status` : activation, agent aux commandes, fenêtre active et progression.
- `computer.stop` : interruption des actions restantes et libération des entrées synthétiques maintenues.

Le mode est désactivé par défaut et activable depuis la session. Une fois actif, l’agent peut passer d’une application à l’autre et regrouper les actions de la tâche sans validation à chaque étape. Le bouton Stop et un raccourci global restent accessibles pendant qu’une autre application est au premier plan.

Un seul agent écrit dans le flux souris/clavier à la fois. Les autres sessions ou sous-agents attendent ou prennent le relais une fois le bureau libéré. Cette coordination est globale au bureau Windows, pas au projet ou au worktree ; elle ne demande pas à l’utilisateur de confirmer chaque transfert.

Associer les actions à la bonne session et à l’état observé. Utiliser des identifiants de requête pour ne pas répéter un clic ou une saisie après une réponse perdue. Ce sont des garanties de cohérence d’exécution, pas une politique de restriction des applications.

## 6. Exécuteur Windows

### Observer

`Windows.Graphics.Capture` fournit des captures de fenêtre ou d’écran, un sélecteur système et un indicateur de capture. C’est le candidat principal pour une fenêtre explicitement choisie par l’utilisateur. Il faut vérifier la disponibilité, la taille, la fraîcheur des images, le redimensionnement et la perte du périphérique graphique. Le backend exact reste à prototyper. [S7]

La capture d’une fenêtre masquée et le contrôle de cette fenêtre sont deux problèmes différents. Capturer des pixels en arrière-plan ne crée pas une seconde souris ni une seconde file de saisie. Les fenêtres minimisées, le contenu protégé et les changements de session demandent des essais dédiés.

### Agir

Préférer les opérations UI Automation lorsqu’un contrôle expose un nom, un rôle et une action exploitable. Utiliser les coordonnées visuelles en secours pour les interfaces qui n’exposent pas de structure utile. Conserver une vérification visuelle après l’action. [S9]

`SendInput` permet de synthétiser souris et clavier, mais n’accepte pas une fenêtre cible comme paramètre. Les entrées vont dans le flux système. Le focus doit être contrôlé et revérifié. `SetForegroundWindow` peut être refusé par Windows, même si certaines conditions sont satisfaites. Il faut alors demander à l’utilisateur de sélectionner la fenêtre, pas contourner les protections. [S8, S10]

Vérifier le nombre d’événements effectivement insérés par `SendInput` ; un résultat nul ou partiel ne doit pas être traité comme un succès. Le retour et `GetLastError` ne permettent pas d’identifier spécifiquement un blocage UIPI. Vérifier également l’état de l’application après la saisie. [S8]

L’exécuteur doit être lancé dans la session interactive autorisée. Un service système ou un autre compte ne donne pas automatiquement accès à son bureau. UI Automation ne permet notamment pas la communication entre applications démarrées par des utilisateurs différents via `Run as`. [S9]

La capture doit annoncer ses dimensions réelles et la transformation vers les pixels physiques. Tester les écrans à 100 %, 125 % et 150 %, les coordonnées négatives d’un écran secondaire et le déplacement de la fenêtre entre écrans. Une capture périmée ou une géométrie modifiée doit invalider l’action.

### Capacités et contraintes de la V1

- Bureau réel, applications multiples, fenêtres, captures, souris, glisser-déposer, texte et raccourcis clavier.
- Pas de liste noire produit des applications ordinaires : le choix des cibles suit la tâche de l’utilisateur et les capacités techniques disponibles.
- Session Windows active requise. `SendInput` reste soumis à UIPI : un exécuteur non élevé ne peut pas piloter librement un programme élevé ou le bureau sécurisé UAC. Ce sont des limites système, pas une politique supplémentaire de Studio. [S8, S11]
- Un seul flux de saisie partagé sur le bureau : ne pas promettre une seconde souris indépendante. L’utilisateur peut arrêter ou reprendre la main.
- Windows en premier. macOS et Linux nécessitent ensuite leurs propres backends.

PyAutoGUI convient pour démontrer rapidement capture, clic et saisie sur le bureau réel. Un worker dédié ou une dépendance du skill évite de modifier sans nécessité tous les noyaux Python. Le backend natif et UI Automation pourront améliorer précision, capture et gestion des fenêtres à partir des résultats mesurés.

## 7. Mode expert et fiabilité

### Expérience visée

1. **Activer Computer Use** dans la session : l’agent peut utiliser le bureau réel pour la tâche demandée.
2. **Exécuter sans friction** : pas de liste d’applications à approuver, pas de confirmation pour chaque clic et pas de VM.
3. **Voir l’activité** : afficher l’agent aux commandes, l’application ciblée, la dernière capture et l’action en cours.
4. **Interrompre immédiatement** : bouton et raccourci global indépendants de la réponse du modèle.
5. **Désactiver le mode** : libérer souris/clavier et retirer cette capacité jusqu’à sa prochaine activation.

Les confirmations ne sont pas une couche produit obligatoire. L’agent peut toujours poser une question lorsqu’il manque une information nécessaire à la tâche. Le contenu d’une page ou d’une fenêtre reste du contexte, pas une nouvelle consigne utilisateur : cela concerne le comportement de l’agent, sans ajouter un système de permissions par clic.

### Modèle de confiance assumé

L’utilisateur professionnel est responsable de l’activation et de l’usage du mode. Il ne s’agit pas d’une sandbox : les actions ont les effets réels des applications et des droits de la session Windows. Un worktree Git ne sépare pas les interactions du bureau. Ce constat décrit le produit, mais ne justifie pas d’ajouter une VM ou une isolation non demandée.

Les restrictions propres à Windows ou au fournisseur du modèle restent des contraintes techniques externes. Les signaler lorsqu’elles bloquent une opération, sans les transformer en interdictions supplémentaires décidées par Studio.

### Arrêt et panne

L’arrêt refuse les commandes non encore envoyées et relâche les touches ou boutons synthétiques maintenus. Il ne peut pas retirer les entrées déjà transmises à `SendInput` ni inverser un clic effectué. Des séquences interruptibles permettent de rester réactif sans imposer un appel modèle entre chaque touche.

Un watchdog séparé du modèle gère crash, timeout et perte du client. Les actions reçues mais dont le résultat est inconnu ne sont pas rejouées aveuglément. Si une touche reste maintenue après une panne, corriger cet état avant de relancer une séquence.

### Captures et accès distant

Les captures sont des observations visuelles envoyées au modèle sélectionné. L’interface doit l’indiquer simplement et montrer la cible actuelle. Utiliser les mécanismes existants de session pour leur transport, avec une conservation raisonnable afin d’éviter des historiques volumineux. Aucun chantier de filtrage automatique des données ou d’audit de conformité n’est requis pour le prototype.

Les clients distants autorisés peuvent suivre la session et utiliser son arrêt. Le contrôle s’exécute toujours sur le PC hôte. Étendre les routes existantes si nécessaire, sans créer une pile séparée de téléadministration pour cette fonctionnalité.

## 8. Prototype et étapes de livraison

Ces étapes sont proposées. Aucune n’a été lancée durant l’étude. La VM et la validation de chaque action sont retirées du périmètre après correction utilisateur.

| Étape                         | Résultat attendu                                                                 | Condition de passage                                                       |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Contrôle du bureau réel    | Capture, clic, saisie et nouvelle observation sur une application locale de test | Le modèle reçoit les pixels et constate l’effet réel de son action         |
| 2. Mode activable dans Studio | Outils natifs, activation/désactivation, fenêtre ciblée et aperçu                | RPC, modèle visuel, retour d’images et arrêt fonctionnent ensemble         |
| 3. Workflows puissants        | Plusieurs applications, glisser-déposer, raccourcis et séquences programmables   | Tâche réalisée sans confirmations à chaque clic, avec reprise après erreur |
| 4. Fiabilité Windows          | DPI, écrans multiples, focus, fermeture de fenêtre, verrouillage et crash        | Pas de coordonnées périmées, d’actions doublées ou de touches bloquées     |
| 5. Bêta utilisable            | Packaging, retour d’activité, diagnostics et mesure du coût                      | Installation reproductible et scénarios répétés sur le bureau réel         |

Le chiffrage initial d’une V1 centrée sur les approbations et l’isolation ne s’applique plus à ce périmètre. Recalculer l’effort après la première boucle capture/action/image ; les inconnues principales sont l’intégration des images, la précision sous Windows et la latence, pas une infrastructure de sandbox.

### Critères de validation proposés

- **Fonctionnel** : Calculatrice, Bloc-notes et navigateur local, puis workflow entre applications ; vérifier le résultat plutôt que le seul message final.
- **Activation** : outils inactifs avant activation, utilisables sans confirmations répétitives après activation, arrêt et désactivation effectifs.
- **Concurrence** : deux agents, parent et enfant, deux projets et client distant sans mélange des frappes ou des clics.
- **Pannes** : modèle lent, worker bloqué, session verrouillée, fenêtre déplacée ou fermée, capture périmée et réponse perdue après une action.
- **Performance** : précision de clic, latence, durée et coût par tâche, fréquence et résolution des captures, capacité à regrouper des actions utiles.

Une réponse finale du modèle ne suffit pas à prouver que la tâche a réussi. Le critère principal est un résultat réellement observé dans l’application.

## 9. Modèles, coût et décisions restantes

La capacité à accepter une image ne garantit pas une bonne précision de clic. Comparer au moins deux modèles réellement disponibles dans les fournisseurs configurés, avec les mêmes tâches et les mêmes budgets. La voie d’outils propres à Studio évite de rendre la fonctionnalité exclusivement dépendante d’OpenAI.

Si une boucle OpenAI dédiée est retenue, vérifier l’accès API et sa facturation séparée de l’abonnement ChatGPT. Aucun appel d’inférence payant n’a été effectué ici. [S12]

Décisions à prendre après le POC : qualité du trajet images, backend le plus fiable, précision des coordonnées, séquences programmables et réactivité de l’arrêt. Le niveau d’isolation n’est pas un choix en suspens : le périmètre demandé est le contrôle direct du bureau réel.

## 10. Sources et limites de l’étude

### Documentation OpenAI lue directement

- [S1. Computer Use, documentation produit](https://learn.chatgpt.com/docs/computer-use)
- [S2. Browser, local et cloud](https://learn.chatgpt.com/docs/browser)
- [S3. API Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [S4. Recettes d’intégration, confirmations, outils propres et migration](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
- [S5. Configuration administrateur](https://learn.chatgpt.com/docs/enterprise/managed-configuration)

### Exemple public et capture Windows

- [S6. Exemple officiel OpenAI, README et code](https://github.com/openai/openai-cua-sample-app/tree/f2a3dc523ae406f9b704f9a420a05402a63b4522)
- [S7. Microsoft, Screen capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [S8. Microsoft, SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [S9. Microsoft, UI Automation Overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview)
- [S10. Microsoft, SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)

### Sources complémentaires

- [S11. Microsoft, fonctionnement UAC](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works), page lue directement.
- [S12. Facturation ChatGPT et API](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform), extrait officiel consulté via recherche ; page complète non consultée.

Les pages produit et API évoluent. Plusieurs pages d’annonce ou du centre d’aide ont refusé la lecture HTTP directe ; les conclusions fonctionnelles s’appuient sur les pages documentaires effectivement lues, pas uniquement sur leurs annonces. La disponibilité produit dépend de la région, du compte et du déploiement.

Méthode : documentation et code lus, deux analyses indépendantes de l’architecture et de l’exécuteur, puis confrontation des limites et des propositions. Aucun contrôle de souris ou de clavier, aucune capture du bureau personnel, aucune installation de dépendance, aucun test de comportement du moteur et aucune modification du code de l’application. Le seul fichier projet ajouté est cette étude.
