# API publique v1

**Français** · [English](en/api.md) · [← Retour au README](../README.fr.md)

L’API publique v1 expose un contrat générique et documenté pour piloter un Studio depuis une application externe : lire les projets et les conversations, démarrer des runs, modifier les roadmaps et télécharger les fichiers liés. Chaque Studio répond directement avec son adresse et son token ; il n’y a ni coordinateur, ni file d’attente partagée, ni relais entre machines.

La référence exacte du contrat est [openapi-v1.json](api/openapi-v1.json), générée depuis `lib/public-api-contract.mjs`. Ce guide la décrit ; en cas de doute, le fichier JSON généré fait foi.

## Documentation interactive et tests

Ouvrir **Préférences → API → Documentation interactive**, ou `/api-docs` sur le Studio choisi (par défaut [http://127.0.0.1:3088/api-docs](http://127.0.0.1:3088/api-docs)). Le contrat servi à `/openapi-v1.json` est généré depuis la même source que cette référence, même quand l’API est désactivée.

Chaque opération dispose de son formulaire : paramètres, corps JSON, droits requis, commande cURL et test manuel avec statut, en-têtes et réponse. Une requête `POST` exige une confirmation explicite : les effets sont réels, y compris les modifications de roadmap et le lancement d’agents. Aucun test n’est lancé automatiquement.

Le token est saisi dans la page, conservé uniquement en mémoire et jamais inséré dans la commande cURL. Les tests visent uniquement l’origine de la page ; pour tester un autre Studio, ouvrir sa page. En accès distant, l’accès à la documentation conserve le PIN/cookie existant ; les appels v1 exigent toujours leur propre token. Aucun accès CORS supplémentaire n’est ouvert.

Les aperçus sont limités à 64 Kio et 30 secondes. Les flux SSE s’affichent progressivement ; leur interruption arrête la lecture, pas le run. Le test de téléchargement propose une petite plage HTTP et ne charge pas le fichier complet en mémoire. Utiliser un client de téléchargement pour récupérer le fichier entier.

## Principes

- L’API est **désactivée par défaut**. Elle s’active dans les Préférences du Studio, sans activer automatiquement le réseau local ou une écoute publique.
- L’API v1 est une façade générique au-dessus des services existants, indépendante des routes internes. Un token v1 n’ouvre jamais les anciennes routes internes, et les anciens Studios sans v1 sont signalés incompatibles sans repli automatique.
- Le client choisit explicitement la machine et le projet local pour chaque appel. Un identifiant de projet reste local à sa machine ; seul le `syncId` permet de reconnaître le même projet entre machines.
- Aucune lecture ne déclenche d’action : consulter un run, une roadmap ou des messages ne démarre ni agent ni tâche, et ne coche aucune étape.
- Aucune prise en charge navigateur inter-origines en v1 : les clients sont des applications ou des scripts directs, sur le réseau local existant ou chiffré.

## Authentification et portées

- Chaque requête envoie `Authorization: Bearer <token>`. Aucun secret ne passe dans l’URL, un cookie, une chaîne de requête SSE ou les journaux.
- Les tokens sont créés et révoqués localement dans le Studio, avec des projets autorisés et une expiration. La gestion des tokens et l’interrupteur restent propres au PC : ni synchronisés, ni exportés, et aucune route publique ne crée de token ni n’augmente ses droits.
- Couper l’API ferme ses flux et téléchargements et bloque les nouvelles requêtes ; révoquer un token ne coupe que ce token. Les runs continuent et s’arrêtent uniquement sur action explicite.

| Portée           | Accès                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `read`           | Machine, projets autorisés, modèles, conversations, runs, événements et roadmaps en lecture |
| `runs:write`     | Démarrer et arrêter un run, envoyer un message, répondre à une interaction                  |
| `roadmaps:write` | Modifier plans, étapes, backlog et liens, avec contrôle de révision                         |
| `files:download` | Télécharger les octets des fichiers liés aux conversations autorisées                       |

Chaque opération exige `read`, plus la portée d’écriture indiquée dans la référence OpenAPI. Lancer un travail depuis une roadmap qui modifie ses liens exige les deux portées d’écriture.

## Machines, projets et modèles

- `GET /api/v1/machine` renvoie `{ apiVersion: "v1", studioVersion, machineId, name, capabilities, idempotency }`, avec `idempotency: { retentionSeconds: 3600, persistent: false }`.
- `GET /api/v1/projects` renvoie les projets autorisés sous forme de page `{ items, nextOffset }`, chaque projet portant `{ id, name, syncId, exists, machineId }`.
- `GET /api/v1/models` renvoie le catalogue moteur sous forme de page `{ items, nextOffset }`, chaque modèle portant `{ id, name?, provider?, input?, reasoning?, thinkingLevels?, contextWindow?, availability? }` (`thinkingLevels` reprend les niveaux natifs ; pas de champ `thinking` au catalogue, contrairement aux requêtes de runs).
- Les listes paginées acceptent `limit` (1 à 200, défaut 50) et `offset` (défaut 0).

## Conversations et runs

- `GET /api/v1/projects/{projectId}/sessions` liste les conversations `{ id, title, createdAt?, updatedAt?, model?, thinking?, machineId, projectId }`.
- `GET /api/v1/sessions/{sessionId}/messages` renvoie `{ sessionId, projectId, machineId, items, nextOffset }`, chaque message reprenant sa projection persistée (`role`, `text`, outils, et pièces jointes en métadonnées seulement : `type`, `id`, `name`, `size`, `mimeType`).
- `POST /api/v1/projects/{projectId}/runs` démarre un run avec `{ requestId, message, sessionId?, model?, thinking?, allowQuestions? }` et répond `201`. `requestId` (16 à 100 caractères `[A-Za-z0-9_-]`) et `message` (200 000 caractères au plus) sont obligatoires. La v1 n’accepte ni envoi initial de pièces jointes, ni images en ligne, ni options d’administration : les images produites pendant le run et liées comme références Markdown locales restent téléchargeables via les fichiers liés.
- `GET /api/v1/runs` et `GET /api/v1/runs/{runId}` exposent les champs `{ id, sessionId, projectId, machineId, status, startedAt, endedAt, error, model, thinking, allowQuestions, interactions, requestId? }`. Un run expiré de la mémoire se consulte via la conversation conservée.
- `GET /api/v1/runs/{runId}/events` diffuse les événements en `text/event-stream` (`id: <seq>` + `data: <événement>`, commentaires `: heartbeat`). Reprenez avec l’en-tête `Last-Event-ID` ou le curseur `?after=` : les événements tamponnés plus récents sont rejoués, précédés d’un marqueur `replay_truncated` si le tampon a avancé, et le flux se termine à la fin du run.
- `POST /api/v1/runs/{runId}/stop` demande l’arrêt avec un corps JSON vide obligatoire `{}` et répond `{ stopped: true, ...run }`.
- `POST /api/v1/runs/{runId}/interactions` répond avec `{ id, response }`, où `response` vaut exactement `{ cancelled: true }`, `{ confirmed: booléen }` ou `{ value: chaîne }`.
- `POST /api/v1/sessions/{sessionId}/messages` envoie `{ requestId, mode: steer | follow_up, message }` au run actif de la conversation.

## Roadmaps

- `GET /api/v1/projects/{projectId}/roadmap` renvoie `{ machineId, projectId, roadmap }`, copie locale identique au document courant sans son chemin interne. Lisez-la avant toute mutation ou lancement : `expectedRevision` concerne cette copie locale, pas un verrou global.
- `POST /api/v1/projects/{projectId}/roadmap/mutations` applique une seule action fermée avec `{ action, expectedRevision, ...champs natifs }`, sans `cwd` ni acteur (le serveur ajoute le chemin en interne). La liste exacte des actions et de leurs champs vit dans le contrat ; tout conflit de révision renvoie `409` avec `currentRevision`.
- `POST /api/v1/projects/{projectId}/roadmap/work` lance le travail **sur cette machine** depuis une sélection, avec exactement `{ requestId, expectedRevision, targets, instructions?, sessionId?, model?, thinking? }`, et répond `201`. La réponse `{ accepted, queued, requestId, run, sessionId, roadmap?, linkWarning?, machineId, projectId }` réutilise le lancement natif existant ; `roadmap` y est le document nu et `run` sa projection complète.
- `step.check` accepte un `sessionId` optionnel comme contexte : la conversation associée dont l’appartenance au projet autorisé choisi est vérifiée (`{ action: "step.check", expectedRevision, planId, stepId|stepIds, done, note?, comment?, sessionId? }`). Conversation inconnue ou d’un autre projet → `404`, identifiant mal formé → `400`. Ce contrôle d’appartenance ne prouve pas l’appelant authentifié ; côté natif, l’appelant réel vérifié est utilisé. Les autres actions gardent leur sens existant de `sessionId` (`plan.attach`, `sessions` de `plan.create`, `roadmapWork`) et n’acceptent pas ce champ ailleurs.
- Chaque étape persistée expose `completion`, en lecture seule : `null` ou `{ machineId, sessionId, completedAt }`. `machineId` égale `GET /machine` du Studio qui a exécuté la vérification, pas celui qui lit ; après synchronisation, il peut donc différer du `machineId` d’enveloppe ou de lecture. `sessionId` est la conversation associée au contrôle (ou `null` sans contexte) ; côté natif, c’est l’appelant réel vérifié. `completedAt` est l’heure en millisecondes epoch. Le contrat OpenAPI documente `RoadmapCompletion` (objet ou `null`, lecture seule), `RoadmapOutputStep` et `RoadmapDocument` ; `RoadmapStep` reste le schéma d’entrée fermé, sans `completion`.
- `completion`, `machineId` et `completedAt` ne s’envoient jamais : tout envoi, y compris dans des objets `steps`, `items` ou `notes` imbriqués, est rejeté en `400`. `GET /roadmap` et les réponses de mutation et de travail documentent `completion` sans affaiblir la validation des requêtes.
- Aucune reprise rétroactive : les étapes `done` antérieures à l’attribution gardent `completion: null` jusqu’à leur prochaine transition. Rouvrir (`done: false`) efface (`null`) ; recocher crée une nouvelle attribution ; répéter le même état `done` conserve l’attribution existante. La synchronisation conserve la source : l’attribution voyage avec l’étape et n’est pas réécrite par le Studio lecteur.
- Côté natif, la conversation enfant courante est créditée, pas la racine : si une conversation enfant coche l’étape, `completion.sessionId` est l’enfant réel vérifié.
- La fin d’un run ne coche jamais automatiquement une étape de roadmap.

## Fichiers liés

- `GET /api/v1/sessions/{sessionId}/files` liste les références prouvées dans l’historique persistant autorisé, sous forme de page d’entrées `{ id, name, size, available, machineId, originMachineId, kind }`, avec `kind: link | attachment`. La preuve est suivie **par référence** : seuls les liens enregistrés depuis des événements natifs réels sur cette machine portent `originMachineId` renseigné. Une référence ancienne ou synchronisée sans reçu local reste `available: false`, `size: null`, `originMachineId: null`, et exige une nouvelle référence locale nouvellement émise ; jamais de rattachement global à la conversation, ni de substitution par un fichier homonyme d’une autre machine. Les images en ligne restent en métadonnées ; les blobs de pièces jointes stockées et les images générées liées en Markdown local sont téléchargeables.
- `GET /api/v1/sessions/{sessionId}/files/{fileId}` télécharge les octets servis par la machine qui détient le fichier, en streaming sans plafond applicatif. `HEAD` sur le même chemin renvoie les métadonnées sans les octets (`Range` ignoré). Réponses : `200` octets, `206` pour une seule plage valide (`Content-Range`), `416` pour une plage insatisfiable, mal formée ou multiple (`Content-Range: bytes */taille`), `304` si `If-None-Match`/`If-Modified-Since` correspond, `412` si `If-Match`/`If-Unmodified-Since` échoue, `404` si le fichier est inconnu ou absent, `409` sans preuve locale (`origin_unknown`). En-têtes : `Accept-Ranges: bytes`, `Content-Length`, `ETag`, `Last-Modified`, `Content-Disposition`. Les `304`/`412`/`416` ne portent aucun corps JSON, contrairement aux erreurs `400`/`404`/`409`. Les préconditions vérifient la version du fichier au début de chaque requête. Elles ne figent pas les octets pendant le transfert : attendre la fin des écritures du producteur avant de télécharger. Un `If-Range` périmé retélécharge en `200` plutôt que de mélanger deux versions.
- La reprise utilise une seule plage HTTP à la fois (`206`, sinon `416`), avec `Content-Length`, `Accept-Ranges: bytes` et validation de version : une précondition `If-Range` devenue fausse retélécharge en `200` plutôt que de mélanger deux versions, et `If-Match` permet d’échouer plutôt que de reprendre un fichier modifié.

## Idempotence et reprises

- Les démarrages (`createRun`, `roadmapWork`, `sendMessage`) exigent un `requestId` : même clé avec le même contenu sur la même machine renvoie le même résultat dans la fenêtre documentée d’une heure ; un contenu différent sous la même clé renvoie un conflit.
- Les clés sont partagées entre tokens pour une même opération et un même projet local (une même session pour les messages). Utiliser des UUID aléatoires, pas de courts compteurs. Les échecs après admission sont conservés aussi : une réponse perdue peut masquer un travail accepté. Inspecter le run/la conversation avant toute nouvelle demande ; ne pas changer de clé à l’aveugle.
- Le cache d’idempotence est en mémoire pendant une heure et ne survit pas au redémarrage : **ne relancez jamais automatiquement sur une autre machine après un dépassement de délai**, car la première peut déjà travailler. Hors ligne signifie état inconnu, pas arrêt confirmé.
- Un conflit roadmap (`409`, `currentRevision`) se résout en relisant la roadmap puis en réappliquant la modification sur la nouvelle révision.

## Deux Studios : choisir, lancer, suivre, télécharger

1. Appeler `/machine` et `/projects` sur A et B avec leurs tokens respectifs. Comparer un `syncId` explicite non nul, jamais le dossier ou le nom affiché ; conserver chaque `id` local avec sa machine.
2. Choisir B. Lire sa `/projects/{projectId}/roadmap`, sélectionner un `planId` existant et conserver la `roadmap.revision` de B.
3. Envoyer `POST /projects/{projectId}/roadmap/work` à B avec un nouveau `requestId` aléatoire, `expectedRevision` et `targets: [{"kind":"plan","planId":"…"}]`. Cela démarre un agent et peut engendrer des frais fournisseur. Les deux droits d’écriture sont nécessaires. Rien n’est réservé ni lancé sur A.
4. Suivre `/runs/{runId}/events` sur B. Répondre aux interactions uniquement après une décision explicite ; ne jamais les confirmer automatiquement. Après la fin du flux, lire `/runs/{runId}` pour connaître le statut final et le `sessionId`.
5. Lister `/sessions/{sessionId}/files` sur B. Choisir un fichier disponible et utiliser son ID opaque pour `HEAD`, puis `GET`. Pour reprendre un téléchargement, envoyer `Range` avec l’ETag sauvegardé dans `If-Match` ; concaténer uniquement un `206` correspondant, jamais un `200`. Si B se déconnecte, son état reste inconnu : ne pas relancer automatiquement son travail sur A.

Les chemins ci-dessus portent le préfixe `/api/v1`. Cet exemple minimal de bibliothèque standard découvre les deux instances sans lancer de travail ni afficher les tokens. Définir localement `STUDIO_A_URL`, `STUDIO_A_TOKEN`, `STUDIO_B_URL` et `STUDIO_B_TOKEN` ; ne pas committer leurs valeurs.

```python
import json, os
from urllib.request import Request, urlopen

for name in ("A", "B"):
    base = os.environ[f"STUDIO_{name}_URL"].rstrip("/")
    headers = {"Authorization": "Bearer " + os.environ[f"STUDIO_{name}_TOKEN"]}
    def get(path):
        with urlopen(Request(base + "/api/v1" + path, headers=headers), timeout=20) as response:
            return json.load(response)
    machine = get("/machine")  # HTTP errors stop here: no fallback, no automatic retry.
    assert machine["apiVersion"] == "v1"
    offset = 0
    while offset is not None:
        page = get(f"/projects?limit=200&offset={offset}")
        for project in page["items"]:
            print(name, machine["machineId"], project["id"], project["syncId"])
        offset = page["nextOffset"]
```

## Erreurs

Les erreurs suivent `{ error, code, currentRevision? }`, avec le statut HTTP adapté : `400` pour une requête invalide, `401` sans token valide, `403` sans la portée requise, `404` pour une ressource inconnue, non autorisée ou expirée, `409` pour un conflit de révision ou d’idempotence, `405` pour une méthode non autorisée et `429` en cas de surcharge. Les fichiers ajoutent `origin_unknown`, `file_missing` et `file_changed`.

## Référence OpenAPI

Le fichier [openapi-v1.json](api/openapi-v1.json) est généré depuis `lib/public-api-contract.mjs` par `node scripts/public-api-openapi.mjs`, avec le serveur de base `http://127.0.0.1:{port}` (`port` : `3088` par défaut) et les portées exigées en `x-required-scopes` sur chaque opération. Le test `test/public-api-contract.test.mjs` vérifie l’égalité entre le fichier et le générateur, la couverture méthodes et portées, la fermeture des actions de mutation sur la liste native, le typage complet des schémas de mutation et la dérivation des `x-required-scopes`.
