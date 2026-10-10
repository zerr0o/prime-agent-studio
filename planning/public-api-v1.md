# API publique v1 — tokens, roadmaps multi-machine et fichiers

Statut : **implémentation terminée, validation locale réussie**. 2026-10-09.
Base vérifiée : Studio 4.2.1-beta.1, commit `ceeaaee`.

## Objectif et décisions confirmées

Permettre à des clients externes de piloter plusieurs Studios avec un contrat documenté et stable.

- Le client externe appelle directement chaque machine avec son adresse et son token. Aucun Studio coordinateur.
- Les roadmaps font partie de la **v1**. Elles restent celles des projets, partagées par la synchronisation Studio existante.
- L’application choisit sur quelle machine démarrer un run lié à un plan ou à une étape.
- Un token peut télécharger les fichiers réellement liés à une conversation autorisée, **y compris hors du projet**, avec une permission distincte.
- Les fichiers n’ont pas de plafond de taille applicatif au téléchargement. Ils ne sont ni copiés automatiquement dans le cloud, ni relayés entre Studios.
- Un interrupteur dans les Préférences autorise ou interdit l’API. Valeur par défaut : **désactivée**.

Hypothèses proposées pour commencer simplement : réseau existant local/Tailscale ; client HTTP natif ou script ; machine hébergeant le fichier en ligne. Pas de nouvelle exposition Internet, de file de travaux hors ligne ou d’affectation différée des tâches.

## 1. Architecture minimale

```text
Client API externe
  ├── adresse A + token A → Studio A → runs et fichiers locaux A
  └── adresse B + token B → Studio B → runs et fichiers locaux B
                              ↕
              synchronisation Studio existante des roadmaps
```

Ajouter une façade `/api/v1`, indépendante du contrat interne `/api/*`, en réutilisant les services métier existants. Ne pas recopier les 99 anciennes entrées ni créer un second moteur de runs/roadmaps. Extraire seulement les fonctions nécessaires actuellement privées dans `server.mjs`.

La passerelle existante reste le point d’accès distant. L’autorisation API est distincte du PIN/cookie et du mode consultation de l’interface distante : un token v1 ne doit jamais ouvrir les anciennes routes internes. L’activation de l’API n’active pas automatiquement LAN, Tailscale ou une écoute publique.

Transport : HTTP loopback accepté ; Tailscale chiffré, HTTPS recommandé. Ne pas envoyer des tokens durables sur un LAN HTTP non chiffré. Aucun Funnel, reverse proxy public ou nouveau certificat à installer pour cette v1. Si le client retenu est une application web, valider son besoin CORS avant l’implémentation : origines explicites, pas de `*` ni d’affaiblissement des protections de l’interface.

## 2. Identités et répartition des runs

- Exposer un `machineId` stable entre redémarrages. **Réutiliser l’identité existante `sync-device.json`** ; partager son initialisation sans configurer ni démarrer la synchronisation. Préserver les IDs déjà présents dans `sync.json`. Ne pas introduire un deuxième identifiant divergent.
- Exposer un `projectId` opaque pour le routage local et le `syncId` existant pour reconnaître le même projet entre machines. Pas de choix automatique par seul nom de projet ou nom de dossier ; un identifiant dérivé du chemin reste local, jamais une identité partagée.
- Le client adresse le projet local de la machine choisie. Un `cwd` de A ne devient pas un chemin utilisable sur B.
- Chaque réponse de run porte sa machine, son projet, son `runId` et son `sessionId` quand connu. Le client externe conserve cette association.
- Garder le document roadmap synchronisé et ses tableaux `sessions[]` existants. Qualifier les liens dans les réponses HTTP et dans l’état du client, sans migration du schéma de synchronisation.
- Réutiliser `roadmapRoutes.work()` pour lancer le travail et associer la conversation au plan. La V1 signifie « démarrer sur cette machine », pas « réserver une tâche pour cette machine plus tard ».
- Lire la roadmap sur la machine cible avant une mutation ou un lancement. `expectedRevision` concerne cette copie locale. La synchronisation reste asynchrone : cette révision n’est pas un verrou global.
- `requestId` obligatoire pour un démarrage : même clé + même contenu + même machine = même résultat dans la fenêtre documentée ; contenu différent = conflit. Documenter précisément rétention et redémarrage. Le cache actuel est en mémoire pendant une heure : **ne pas promettre un retry sûr après redémarrage ou expiration**.
- Pas de garantie « exactement une fois » entre machines. Ne jamais relancer automatiquement sur B après un timeout de A : A peut déjà travailler. Hors ligne = état inconnu, pas arrêt confirmé.
- L’état « en cours » vient de la machine qui exécute le run. Une fin de run ne coche pas automatiquement une étape de roadmap.

## 3. Autorisation et Préférences

Une section **API** dans les Préférences du Studio :

1. Interrupteur global, désactivé par défaut, et adresse disponible/état de l’accès réseau.
2. Création locale d’un token nommé par intégration, avec projets autorisés et expiration configurable.
3. Secret affiché une seule fois ; liste des tokens, permissions, expiration et action de révocation.
4. Avertissement explicite avant d’accorder le lancement d’agents ou le téléchargement hors projet.

Permissions minimales proposées :

| Scope            | Accès                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `read`           | Machine, projets autorisés, modèles, conversations, runs/événements et roadmaps en lecture |
| `runs:write`     | Démarrer/arrêter un run, envoyer un message et répondre à une interaction                  |
| `roadmaps:write` | Modifier plans/étapes/backlog et leurs liens, avec contrôle de révision                    |
| `files:download` | Télécharger les fichiers liés aux conversations autorisées, y compris hors projet          |

Un lancement depuis une roadmap qui modifie ses liens exige les droits correspondants. La lecture d’une conversation ne donne pas automatiquement accès aux octets des fichiers liés.

`Authorization: Bearer …` uniquement : pas de secret dans URL, cookie, SSE query string ou journaux. Token aléatoire à forte entropie, stockage de son empreinte uniquement, comparaison sûre, révocation individuelle et contrôle d’expiration. Réutiliser `node:crypto`, pas d’OAuth ni de nouvelle base de données pour cette v1.

Les tokens, leurs paramètres sensibles et l’interrupteur restent propres au PC ; ils ne sont pas synchronisés ni exportés dans les archives. Aucune route publique ne crée un token, n’augmente ses droits ou ne réactive l’API.

Couper l’API ferme ses SSE et téléchargements actifs et bloque toutes les nouvelles requêtes. Révoquer un token ne coupe que les accès de ce token. **Les runs continuent** ; leur arrêt reste une action explicite. Une désactivation conserve les tokens inactifs pour une réactivation ; la révocation, elle, est définitive.

## 4. Contrat HTTP proposé — à figer en OpenAPI

Noms indicatifs ; schémas exacts à valider avant codage. Les réponses sont des projections stables, pas des objets internes exportés en bloc.

| Besoin                      | Routes proposées                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Machine et compatibilité    | `GET /api/v1/machine`                                                                    |
| Projets et modèles          | `GET /api/v1/projects`, `GET /api/v1/models`                                             |
| Conversations et historique | `GET /api/v1/projects/{projectId}/sessions`, `GET /api/v1/sessions/{sessionId}/messages` |
| Runs                        | `POST /api/v1/projects/{projectId}/runs`, `GET /api/v1/runs`, `GET /api/v1/runs/{runId}` |
| Suivi et commandes          | `GET /api/v1/runs/{runId}/events`, `POST …/stop`, `POST …/interactions`                  |
| Messages en direct          | `POST /api/v1/sessions/{sessionId}/messages`                                             |
| Roadmap                     | `GET /api/v1/projects/{projectId}/roadmap`                                               |
| Modifications roadmap       | `POST /api/v1/projects/{projectId}/roadmap/mutations`                                    |
| Lancer depuis la roadmap    | `POST /api/v1/projects/{projectId}/roadmap/work`                                         |
| Fichiers liés               | `GET /api/v1/sessions/{sessionId}/files`                                                 |
| Contenu et métadonnées HTTP | `GET` / `HEAD /api/v1/sessions/{sessionId}/files/{fileId}`                               |

Pour les mutations roadmap, exposer une union d’actions **typées et fermées** qui réutilisent le service existant : plans, étapes, backlog et liens. Pas de corps libre « JSON » ni de changement de schéma natif. Les coches et suppressions restent explicites.

Le contrat fixe aussi : listes bornées/pagination, filtrage par projets autorisés, erreurs machine-readable, révisions/conflits, capacités et versions, état d’un run avant création de sa session, rétention des runs/SSE, `Last-Event-ID`, `replay_truncated`, déconnexion et idempotence. Après expiration d’un run en mémoire, consulter la conversation conservée plutôt que promettre un historique de runs durable inexistant.

Un ancien Studio sans v1 est indiqué comme incompatible ; **aucun repli automatique sur l’API interne ou le PIN**.

## 5. Fichiers liés : sans plafond applicatif, sans accès arbitraire

Aujourd’hui, `project-files.download` plafonne à 50 Mio et lit tout en mémoire. Il ne suffit donc pas d’enlever sa constante : créer une route publique en streaming sans affaiblir les routes internes.

- La liste de fichiers provient de références réellement présentes dans l’historique persistant autorisé : liens locaux reconnus et pièces jointes. Un chemin trouvé dans du texte quelconque n’est pas automatiquement un lien exportable.
- Le serveur fournit un `fileId` opaque lié à la conversation/référence et à la machine. Le téléchargement n’accepte jamais un chemin arbitraire, même avec `files:download`.
- Vérifier l’autorisation de la conversation et la référence à chaque accès. Résoudre et ouvrir un fichier régulier local ; refuser dossiers, périphériques, pipes, URL réseau/UNC et contournements de chemins. Contrôler les symlinks/jonctions et les changements entre vérification et ouverture, sans réintroduire une restriction « dossier du projet uniquement ».
- Le droit de télécharger un fichier lié hors projet est volontairement sensible. Prévenir qu’un lien vers un fichier privé peut exposer son contenu ; ne pas promettre qu’un filtre d’extensions protégera tous les secrets.
- Indiquer la machine qui **sert réellement les octets**, la disponibilité locale et l’origine si elle est connue. Le dernier appareil ayant synchronisé une session n’est pas une preuve de possession du fichier.
- Pour un run lancé par un client API, son hôte est le premier interlocuteur. Pour les liens anciens/synchronisés dont l’origine est inconnue, l’indiquer et laisser le client vérifier les machines autorisées ; ne pas inventer une origine ni substituer silencieusement un fichier homonyme sur un autre PC.
- Streaming depuis le disque avec backpressure, `HEAD`, `Content-Length`, `Accept-Ranges: bytes`, une plage HTTP à la fois (`206` / `416`) et validation de version pour la reprise. Pas de `readFile()` du fichier complet, de buffer global, de ZIP ou de copie cloud préalable.
- Taille non plafonnée par l’application, mais limitée en pratique par disque, droits, réseau et disponibilité de la machine. Fichier supprimé/déplacé/modifié : erreur documentée ; ne pas concaténer deux versions lors d’une reprise.
- Les limites des **uploads** existants ne changent pas. Limiter connexions/débits si nécessaire plutôt que la taille totale des fichiers.

## 6. Ordre de réalisation et critères de fin

### Lot 0 — référence actuelle (fait pour ce cadrage)

Conserver la source HTML dans `docs/api/PrimeAgentStudio-API-Tailscale.html` et générer le PDF à part. Corriger formats de corps, permissions GET/POST, limites combinées, délais et exemple Python sans confirmation automatique. Ce document décrit toujours l’API interne, pas la future v1.

### Lot 1 — contrat et tests d’autorisation

Rédiger `docs/api/openapi-v1.json`, les exemples client minimaux et la matrice routes/scopes/projets. Figer identités, erreurs, idempotence/rétention, provenance des fichiers et règles de reprise. Décrire un scénario complet : deux Studios → même `syncId` → choix d’un plan → run sur B → SSE de B → téléchargement depuis B. Pas de SDK ni génération de serveur inutile.

### Lot 2 — accès API et préférences

Interrupteur, tokens par intégration, identité machine commune avec la sync, garde v1 et section Préférences EN/FR. Vérifier refus sans token, mauvais token, token expiré/révoqué, mauvais projet, droits insuffisants ; aucune acceptation du token sur une route interne.

### Lot 3 — conversations, runs et roadmaps

Projections de lecture ; mutations roadmap ; réutilisation de `roadmapRoutes.work()` ; contrôle de révision ; démarrage idempotent dans sa fenêtre définie ; messages, interactions, arrêt et SSE. Vérifier deux machines sans nouveau coordinateur, compatibilité des roadmaps avec les anciens Studios, aucune action déclenchée par une lecture et aucune coche automatique.

### Lot 4 — téléchargements

Références de fichiers autorisées, identifiants opaques, streaming/reprise et disponibilité de la machine. Tests : hors projet explicitement lié autorisé ; chemin libre/ref forgée/autre conversation refusés ; chemins Windows et espaces ; liens/symlinks/jonctions hostiles ; fichier disparu/modifié ; `HEAD`, plages valides/invalides ; interruption puis reprise. Vérifier les offsets au-delà de 4 Gio avec fixture adaptée et la mémoire bornée sous lecteur lent, sans imposer un fichier géant au dépôt/CI.

### Lot 5 — validation réelle et documentation publique

Tests de contrat OpenAPI, matrice de droits et révocation pendant SSE/download (run toujours actif), API désactivée au redémarrage si telle est sa préférence enregistrée. Tester deux Studios réels avec projet synchronisé, machine hors ligne puis reconnexion, absence de doublon dans la fenêtre documentée et absence de retry automatique après redémarrage. Vérifier que les secrets ne sortent ni dans logs, sync, archives ni réponses. Mettre à disposition une documentation publique EN/FR et un exemple client minimal. Le PDF public sera dérivé du contrat, pas entretenu comme une seconde vérité.

Aucune publication/version/compilation automatique n’est demandée par ce plan.

## Validation réalisée le 2026-10-09

- API et Préférences génériques, sans comportement spécifique à un type de client.
- `npm test` : **1 146 réussis, 1 ignoré, aucun échec**. Le test natif Windows utilise l’interpréteur du profil du projet (`PRIME_AGENT_KERNEL_PYTHON`, chemin fourni par `.local/kernel-ready.json`).
- `npm run check` : syntaxe, 2 085 traductions et 17 paires de documentation / 286 liens vérifiés.
- `node scripts/test-public-api-settings-ui.mjs` : **18 contrôles réussis**, dont création/révocation/désactivation via les vrais endpoints locaux et absence de secret dans le stockage du navigateur. Capture locale : `.local/public-api-preferences.png`.
- Deux instances HTTP isolées : identités et tokens distincts, `syncId` partagé, exécution sur l’instance choisie, coupure/reconnexion sans doublon et sans lancement sur l’autre instance.
- Synchronisation native des roadmaps testée avec un stockage objet passif en mémoire, sans modifier son schéma. La fin d’un run ne coche aucune étape.
- Téléchargement de 32 Mio interrompu par révocation puis désactivation, run toujours actif, reprise `206` avec `If-Match`. Offsets au-delà de 4 Gio vérifiés sans fixture géante. Protections de chemins, descripteurs, provenance locale et préconditions HTTP couvertes.
- Deux revues indépendantes ; corrections vérifiées, aucun blocage restant signalé.

Portée de cette validation : serveurs HTTP réels sur ce PC, profils temporaires et moteur d’agent simulé. Aucun appel de modèle payant, aucune modification du profil utilisateur. Un essai sur deux PC physiques via leur réseau Tailscale reste une vérification de déploiement, non réalisée ici.

Documentation publique : [guide FR](../docs/api.md), [guide EN](../docs/en/api.md), [contrat OpenAPI](../docs/api/openapi-v1.json). Aucun commit, build, packaging ou publication effectué pour cette implémentation.

## Hors périmètre v1

Développement du client API externe ; orchestration centrale ; verrou distribué ; queue hors ligne ; réservation future des tâches par machine ; stockage/replication cloud de fichiers ; proxy Studio-à-Studio ; API Internet hébergée ; OAuth ; administration des clés fournisseurs/MCP/réseau ; mises à jour ; opérations Git mutantes ; contrôle du bureau ; import/export d’archives via token.

## Repères dans le code actuel

- `server.mjs` : dispatch HTTP, runs, interactions et SSE.
- `lib/lan.mjs`, `lib/remote-access.mjs`, `lib/remote-network.mjs` : frontière réseau/PIN et fermeture des connexions, à préserver pour l’interface.
- `lib/store.mjs` : projets, `syncId`, préférences et projection de l’historique.
- `lib/conversation-sync.mjs` : identité `sync-device.json`, synchronisation et information d’appareils ; pas de transfert automatique des gros fichiers liés.
- `lib/roadmap-routes.mjs` : révisions, lancement idempotent, associations run/session.
- `lib/roadmap.mjs`, `lib/roadmap-merge.mjs`, `lib/roadmap-session.mjs`, `lib/roadmap-bridge.mjs` : document, fusion, liens et activité locale.
- `public/file-links.js`, `lib/project-files.mjs`, `lib/files.mjs` : reconnaissance/résolution des références et limites actuelles, à réutiliser sans confondre lecture d’une conversation et droit sur ses fichiers.
