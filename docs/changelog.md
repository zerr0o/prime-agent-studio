# Historique des versions

[English](en/changelog.md) · **Français** · [← Retour au README](../README.fr.md)

Les changements par version. Retrouvez les installateurs et les archives du code source dans les [releases GitHub](https://github.com/zerr0o/prime-agent-studio/releases).

## 4.2.1-beta.3

- **Bandeau et champ de saisie mobiles** : les actions regroupées tiennent à 320 et 390 px, le texte indicatif reste entièrement visible pendant un tour, et les libellés courts des permissions conservent leurs noms accessibles complets. La disposition desktop et le panneau de détails mobile plein écran sont préservés.
- **Provenance des validations Roadmap** : chaque nouvelle étape validée enregistre l’identifiant du Studio, la conversation associée (si disponible) et la date de validation. Ces détails se consultent sous l’étape sans lancer d’agent.
- **Historique conservé** : recocher une étape déjà validée ou modifier un autre champ conserve l’attribution ; rouvrir l’étape l’efface. La synchronisation et l’export/import `.pastudio` conservent la source sans l’attribuer au Studio destinataire. Les anciennes validations ne sont pas renseignées rétroactivement.
- **API et OpenAPI** : les métadonnées `completion`, en lecture seule, sont documentées et renvoyées pour les étapes Roadmap. `step.check` accepte un `sessionId` facultatif vérifié dans le projet choisi ; les agents natifs utilisent leur conversation courante vérifiée, y compris une conversation enfant.

## 4.2.1-beta.2

- **API publique v1 pour les intégrations externes** : jetons Bearer limités aux projets choisis, projets et conversations, contrôle des runs, SSE avec reprise, lecture et écriture Roadmap, téléchargement des fichiers liés. L’API est désactivée par défaut et se gère localement dans **Préférences → API**.
- **Documentation OpenAPI interactive** : ouvrir `/api-docs` depuis les Préférences pour tester manuellement chacune des 18 opérations, avec JSON, cURL, statut, en-têtes et réponse. Les jetons restent en mémoire dans la page ; les tests POST demandent une confirmation ; les aperçus de flux et fichiers sont limités et annulables.
- **Droits limités et reprises sûres** : permissions distinctes pour les runs, roadmaps et fichiers, expiration et révocation des jetons, déduplication des requêtes en mémoire pendant une heure, conflits de révision et nouvelle vérification des droits avant les actions différées.
- **Transfert et reprise des fichiers** : HEAD, plages d’octets et validateurs, avec contrôle de provenance locale par référence pour éviter de substituer un fichier venant d’un autre PC.
- **Limites distantes conservées** : les jetons API n’ouvrent ni les routes internes ni la gestion distante des jetons. Les appels distants exigent Tailscale ou HTTPS ; le LAN HTTP non chiffré et les navigateurs d’une autre origine ne sont pas ouverts.
- **Documentation et validation** : guides FR/EN, contrat OpenAPI généré et contrôles navigateur pour toutes les opérations. L’exécution peut lancer du code et engendrer des coûts fournisseur ; les fichiers liés peuvent être hors du projet. Désactiver l’API n’arrête pas les agents déjà en cours.

## 4.2.1-beta.1

Bêta de maintenance basée sur la 4.2.0. Aucune nouvelle fonctionnalité visible ni modification de l’API.

- **Moins de code dupliqué** : les tests d’intégration Computer Use utilisent désormais le résolveur d’appelant de production ; l’analyse JSONC, l’attente du processus desktop et les utilitaires de mise à jour Rust réutilisent leurs implémentations existantes.
- **CRC32 standard** : les archives et les images de test utilisent le CRC32 de Node.js au lieu de copies séparées. Un test de régression couvre les archives stockées et compressées et refuse les données endommagées.
- **Nettoyage de l’interface** : suppression d’un calcul d’état de synchronisation inutilisé, d’un import inutilisé et d’un export de traduction inutilisé.
- **Maintenance simplifiée** : les tests d’interface conservent les mêmes choix et replis de navigateur avec moins de code de préparation. Un seul workflow de release gère les nouveaux builds et la reconstruction des brouillons.

## 4.2.0

Version stable. Inclut toutes les bêtas 4.1.5 ci-dessous, plus :

- **Contrôle complet depuis le téléphone** : un appareil distant en contrôle complet peut tout faire comme le PC (fournisseurs et clés, modèles, synchronisation, archives `.pastudio`, worktrees, réglages d’accès distant). Le mode consultation reste en lecture seule. Les sélecteurs de dossier et l’Explorateur s’ouvrent toujours sur l’écran du PC.
- **Message de commit proposé** : « Proposer un message » dans le panneau Git rédige un message conventionnel à partir des fichiers cochés, dans la langue de vos commits récents. Il utilise le modèle auxiliaire s’il est défini, sinon le modèle par défaut ; les identifiants restent dans un processus séparé.
- **Avertissement de conflit de Roadmap** : quand une Roadmap ne peut pas être fusionnée, le panneau de synchronisation indique le projet et l’emplacement de la copie de l’autre PC, et le statut de synchronisation passe en orange.
- **Marqueur d’origine des conversations** : l’icône de PC indique le PC qui a écrit le dernier message, et non un PC qui a seulement renvoyé l’état lu.
- **Corrections** : l’aperçu du raisonnement reste visible sur les réponses terminées ; la barre de saisie tient à 320 px ; les Fournisseurs sont accessibles sur téléphone.
- **Fiabilité** : les tests d’interface choisissent un navigateur installé, et les tests instables (interface et mise à jour Rust) sont corrigés.

## 4.1.5-beta.15

- **Plus de tours inutiles après une réponse** : quand un sous-agent se termine après avoir déjà répondu à un parent occupé, son avis de fin est gardé comme contexte pour le prochain message, au lieu de lancer un appel au modèle par sous-agent après la réponse. Un parent inactif, ou un sous-agent qui n’a pas répondu, réveille toujours le parent.

## 4.1.5-beta.14

- **Clé de recherche web** : la clé Serper utilisée par la recherche web de l’agent se configure dans Préférences → Modèles et agents → Fournisseurs (rechercher « web »). Elle est enregistrée au même endroit que `/login` du CLI.
- **Fin de réponse plus lisible** : les notices de fin des sous-agents (terminé, sans réponse, annulé) rejoignent le groupe d’activité de l’agent au lieu d’afficher une carte « Contexte » chacune après la réponse.

## 4.1.5-beta.13

- **Mise à jour** : même code que la 4.1.5-beta.12, publié sous un nouveau numéro pour que les installations d’un build de test local 4.1.5-beta.12 reçoivent la mise à jour.

## 4.1.5-beta.12

- **Couleurs dans le menu du plan** : le menu du plan (« ··· » ou clic droit) affiche les pastilles de couleur ; un clic applique la couleur.
- **Synchronisation de la Roadmap plus rapide** : une modification est envoyée 2 secondes après le changement, et une Roadmap ouverte récupère les changements des autres PC au plus une fois par minute.
- **Couleur du PC** : le choix de la couleur de ce PC dans Préférences → Synchronisation fonctionne (il était refusé comme configuration invalide).

## 4.1.5-beta.11

- **Synchronisation de la Roadmap** : la Roadmap de chaque projet synchronisé se synchronise entre PC, avec une fusion à trois versions basée sur la dernière version synchronisée ; une modification d’un seul côté l’emporte, en cas de modification des deux côtés la plus récente gagne, et ajouts comme suppressions sont conservés. Une copie distante inutilisable est sauvegardée, jamais perdue.
- **Backlog horodaté** : les entrées reçoivent un identifiant stable et des dates ; si deux PC créent le même numéro hors ligne, l’entrée la plus ancienne le garde.
- **Couleurs** : palettes distinctes pour les projets, les plans de Roadmap et les PC. Les couleurs des plans, des projets et de chaque PC se synchronisent.
- **Marqueur d’origine** : une conversation lancée en dernier sur un autre PC affiche une icône d’écran à la couleur de ce PC, dans la barre latérale et l’en-tête.
- **Menu contextuel de la Roadmap** : un clic droit sur un plan, un jalon ou une ligne du backlog ouvre le même menu que « ··· ».

## 4.1.5-beta.10

- **Machines dans la PWA** : un nouvel écran Machines liste les PC qui font tourner le Studio. Ajoutez un PC en scannant le QR code de ses Préférences → Accès distant, à partir d’une photo de ce code, ou en saisissant son adresse. Renommez, modifiez ou retirez une machine ; la liste reste sur le téléphone.
- **Ouverture sur la liste** : dès qu’une autre machine est enregistrée, la PWA s’ouvre sur cette liste. Elle s’ouvre aussi quand le PC ne répond pas, et l’écran de reconnexion propose « Ouvrir une autre machine ».
- **Un accès par PC** : chaque PC garde sa passerelle, son code d’accès et ses sessions. Un PC mis à jour vers cette version garde votre session quand vous l’ouvrez depuis la liste.

## 4.1.5-beta.9

- **Git dans l’onglet Fichiers** : sélecteur de branches avec recherche (branches locales et distantes, nouvelle branche), compteurs d’avance et de retard, Récupérer, Pull (avance rapide uniquement) et Push (jamais forcé, branche amont créée pour une nouvelle branche).
- **Commit depuis Studio** : choix des fichiers par cases à cocher, message sur plusieurs lignes, puis commit (Ctrl+Entrée). Les hooks du dépôt s’exécutent au commit et au push ; un commit refusé laisse l’index inchangé.
- **Sécurité** : changer de branche n’écrase jamais les modifications locales ; changement de branche et pull bloqués pendant qu’un agent travaille dans le projet. Disponible à distance en contrôle complet.

## 4.1.5-beta.8

- **Attente des sous-agents plus claire** : quand un tour se termine alors que des sous-agents travaillent encore, l’indicateur d’activité affiche « Attend ses sous-agents » au lieu de « Fin de tour ». Il passe à « Fin de tour » quand le dernier sous-agent a terminé.

## 4.1.5-beta.7

- **Aligner Git** est maintenant un bouton principal dans le panneau Session.
- **Lanceur** : l’écran de démarrage indique la version requise Prime Agent 0.9.8 au lieu de 0.9.7.
- **Code allégé** : fonctions dupliquées retirées sans changement de comportement ; 16 tests UI et natifs auparavant non branchés passent par `npm run test:*`.

## 4.1.5-beta.6

- **L’état lu se synchronise entre PC** : une conversation lue sur un PC n’est plus non lue sur l’autre ; « Marquer comme non lu » aussi. La dernière action l’emporte.
- **Contexte Git dans le panneau Session** : branche et commit enregistrés par la conversation, comparés à ce PC.
- **Aligner Git** : place le projet sur la branche et le commit de la conversation (fetch, switch, fast-forward uniquement). Refusé en cas de modifications non commitées, de divergence ou de commit non poussé ; rien n’est écrasé.
- **Statut plus clair** : une conversation en cours n’est plus comptée « à envoyer », et « Synchroniser maintenant » affiche toujours le résultat.

## 4.1.5-beta.5

- **Identité stable des projets entre PC** : un projet synchronisé est reconnu par son dépôt Git, puis par son nom, ou par un lien explicite, même après un renommage.
- **Liste des projets synchronisés** : voir les projets des autres PC, leur mode de liaison, et ajouter un projet manquant en choisissant son dossier local.
- **Choix du lien** à l’ajout d’un dossier, et « Lier la synchronisation… » dans le menu du projet.

## 4.1.5-beta.4

- **Panneau de synchronisation** : statut et « Synchroniser maintenant » en haut, configuration repliée en dessous ; « Oublier » est un bouton rouge avec confirmation intégrée.
- **Compteur exact** : les conversations déjà envoyées par une bêta précédente ne s’affichent plus « à envoyer ».
- **Mises à jour plus légères** : le statut ouvre directement l’onglet Synchronisation, et la barre latérale n’est redessinée que si un badge change.
- **Panneau Session** : le quota est juste sous la session et se met à jour toutes les 5 minutes ; la note sur le terminal est supprimée.

## 4.1.5-beta.3

- **Statut de synchronisation visible** : statut permanent sous l’état du moteur (synchronisé, envoi avec progression, changements à envoyer, erreur), badge sur les dossiers synchronisés et état de la conversation dans l’en-tête.
- **Vérification à l’ouverture** : ouvrir une conversation récupère rapidement sa dernière version depuis R2, en conservant le brouillon. Les tours terminés sont envoyés immédiatement.
- **Épinglage, titre et archivage** sont synchronisés entre PC ; la modification la plus récente l’emporte.
- **Reconnexion plus sûre** : oublier puis reconnecter le même bucket ne renvoie plus tout l’historique.

## 4.1.5-beta.2

- **Synchronisation des conversations (bêta)** : synchronise les conversations entre PC via votre propre bucket Cloudflare R2, avec chiffrement avant l’envoi. Seuls les nouveaux messages sont envoyés et les images ne sont stockées qu’une fois. Aucune machine n’a besoin de rester allumée.
- **Synchronisation par projet** : activée par défaut, désactivable à l’ajout d’un dossier ou depuis le menu du projet.
- **Roue Alt** : titres contenus dans les tranches, titre de conversation au-dessus du projet, légère teinte des tranches en cours ou non lues.

## 4.1.4

- **Prime Agent 0.9.8** : mise à jour de la découverte des modèles et rafraîchissement du sélecteur natif à chaque ouverture. Studio conserve son identité Codex plus récente pour GPT-6.1 Sol.

- **GPT-6.1 Sol** : ajout du modèle pour l’API OpenAI et les comptes Codex éligibles, avec raisonnement toujours actif, tarification du cache API et identité du client Codex officiel courant. Les réglages par défaut et les contrôles d’accès sont conservés.

- **Prime Agent 0.9.7** : mise à jour du moteur géré pour mieux traiter les grosses sorties Python, fiabiliser l’activité des sessions natives et intégrer les correctifs amont d’Azure Responses et de Gemma 4 sur Vertex.
- **Relais fiable des sous-agents** : le parent reçoit un avis natif de fin d’exécution, même après des messages de progression de l’enfant. Cet avis signale la fin de l’exécution, pas la réussite de la tâche.
- **Messages enfants ordonnés** : la tâche initiale est admise avant les messages précoces, y compris les diffusions et les messages entre agents frères. Les erreurs de démarrage, annulations et suppressions débloquent toujours les expéditeurs en attente.
- **Migration sûre du moteur** : une nouvelle génération du moteur et de Python est préparée en conservant les anciens fichiers. Aucun kernel actif n’est modifié sur place.
- **Diagnostics natifs fiables** : les vérifications en lecture seule ne s’annulent plus lorsque leur entrée est fermée, évitant les faux signalements de chemins moteur et uv invalides.
- **Confirmation après maintenance** : une opération terminée ne bloque plus la confirmation de redémarrage lorsque des agents travaillent. Les protections des opérations encore en cours sont conservées.

## 4.1.4-beta.2

- **GPT-6.1 Sol** : ajout du modèle pour l’API OpenAI et les comptes Codex éligibles, avec raisonnement toujours actif, tarification du cache API et identité du client Codex officiel courant. Les réglages par défaut et les contrôles d’accès sont conservés.

## 4.1.4-beta.1

- **Prime Agent 0.9.7** : mise à jour du moteur géré pour mieux traiter les grosses sorties Python, fiabiliser l’activité des sessions natives et intégrer les correctifs amont d’Azure Responses et de Gemma 4 sur Vertex.
- **Relais fiable des sous-agents** : le parent reçoit un avis natif de fin d’exécution, même après des messages de progression de l’enfant. Cet avis signale la fin de l’exécution, pas la réussite de la tâche.
- **Messages enfants ordonnés** : la tâche initiale est admise avant les messages précoces, y compris les diffusions et les messages entre agents frères. Les erreurs de démarrage, annulations et suppressions débloquent toujours les expéditeurs en attente.
- **Migration sûre du moteur** : une nouvelle génération du moteur et de Python est préparée en conservant les anciens fichiers. Aucun kernel actif n’est modifié sur place.
- **Diagnostics natifs fiables** : les vérifications en lecture seule ne s’annulent plus lorsque leur entrée est fermée, évitant les faux signalements de chemins moteur et uv invalides.
- **Confirmation après maintenance** : une opération terminée ne bloque plus la confirmation de redémarrage lorsque des agents travaillent. Les protections des opérations encore en cours sont conservées.

## 4.1.3

- **Suppression d’un sous-agent sans fermeture du parent** : l’annulation de l’attente d’un enfant reste locale à cet enfant. Le parent attend les autres travaux délégués au lieu de fermer la session. L’arrêt explicite du parent et les autres erreurs restent propagés.

- **Notices de contexte compactes** : les rappels ordinaires d’objectif rejoignent l’Activité de l’agent, les résumés de compactage et de branche sont repliés par défaut et les cartes d’activité terminées prennent moins de place. Les alertes de budget, changements d’objectif et notices inconnues restent visibles. Les détails complets restent accessibles ; l’historique natif et le contexte envoyé au modèle sont inchangés.

- **Clic sur les notifications Windows** : tant que Studio fonctionne, un clic affiche l’application et ouvre la conversation concernée, même dans un autre projet, en conservant les brouillons. Cela ne relance pas une application entièrement quittée.
- **Marquer comme non lu** : le menu de conversation met à jour l’état de lecture partagé par la barre latérale et le menu Alt. Marquer la conversation ouverte renvoie à la vue d’ensemble du projet et conserve son brouillon.
- **Couleurs de projet plus vives** : les anciennes couleurs pastel utilisent leur équivalent vif. Les épingles de projet et des conversations épinglées inactives reprennent cette couleur ; les indicateurs d’activité gardent leur priorité.
- **Préférences plus claires** : Computer Use reçoit une brève explication, les fournisseurs précèdent les modèles et les versions de l’application installée et du serveur en cours sont visibles sans déplier les détails techniques. Les notifications internes apparaissent au-dessus du flou des préférences.

- **Navigation rapide entre conversations** : maintenez **Alt** pour ouvrir un menu radial animé au-dessus de l’espace de travail. Il affiche les six conversations non archivées modifiées le plus récemment, tous projets confondus, triées par titre. Chaque portion indique le nom du projet en gras et sa couleur.
- Survolez une portion ou appuyez sur **1 à 6 au pavé numérique**, puis relâchez **Alt** pour l’ouvrir. Revenez au centre ou appuyez sur **Échap** pour annuler. Les brouillons sont conservés ; les préférences de réduction des animations sont respectées.
- **Indicateurs d’activité en direct** : le menu radial reprend les pastilles de la barre latérale pour les agents en cours, les réponses non lues et les questions en attente. Elles se mettent à jour sans fermer le menu.

## 4.1.2 (incluse dans 4.1.3)

- **Revue du harness dans Connaissances du projet** : nouveaux filtres **Prompts**, **Skills** et **Subagents** pour voir toutes les entrées natives reçues par l’agent. **Global** n’affiche que les entrées partagées entre projets.
- **Quota Claude** : les sessions qui utilisent un abonnement Claude lié (OAuth) affichent le quota sur 5 heures et hebdomadaire, comme Codex. Si l’agent principal et les sous-agents utilisent des abonnements différents, les deux quotas sont affichés. Actualisation manuelle uniquement ; aussi dans Fournisseurs.
- **Contexte de l’agent allégé** : les longues listes de variables Python restaurées sont remplacées par leur nombre dans les requêtes envoyées au modèle. Le fichier de session garde la liste complète. Mesuré sur une longue session : environ 816 000 caractères de ces notices ramenés à 8 000.
- **Quota plus stable** : le quota Codex ne disparaît plus brièvement environ toutes les minutes.
- **Annuler ce refinement** et **Corriger** pré-remplissent une commande native `/refine` dans la conversation concernée. Rien ne s’exécute avant l’envoi ; le Studio n’écrit jamais lui-même dans le harness. Masqués en accès distant en lecture seule.

## 4.1.1

- **Conversation** : messages inter-agents et notifications techniques regroupés dans « Activité de l’agent », sans modifier l’historique. Les réponses et interactions restent accessibles ; les aperçus de réflexion terminés sont masqués.

- **Maintenance** : suppression des helpers inutilisés du noyau, du bridge Computer Use et des composants UI ; détection du bridge et confirmation de redémarrage partagées, sans changer les règles d’autorisation ou d’annulation.
- **Implémentations partagées** : réutilisation de la détection des configurations JSONC, de la préparation des lancements PowerShell et du writer atomique Rust existant, avec conservation des validations et des erreurs.
- **Tests de sécurité des images** : retrait des filtres obsolètes et tests directs du normaliseur de contexte actif. Les limites des captures Computer Use et l’historique en entrée restent inchangés.
- **Couverture de régression** : vérifications renforcées de l’annulation du redémarrage et du nettoyage après échec d’écriture atomique. Aucune nouvelle dépendance.

## 4.1.0 (pre-release)

- **Prime Agent 0.9.6** : préparation du moteur épinglé avec un environnement Python géré distinct. Les contrôles exigent les nouvelles méthodes de découverte MCP. Le correctif natif des commandes en arrière-plan est reconnu sans réécrire son implémentation.
- **Réglages natifs des modèles** : le sélecteur partagé expose `imageModel` pour les tours avec images sur un modèle texte. L’aide du modèle auxiliaire couvre l’affinage et les résumés de compaction et de branche. Le niveau de service par défaut propose Standard, Flex, Priority et Auto sans modifier les sessions actives. Les tours routés avec images conservent le modèle de conversation lors d’une reprise ultérieure, par ajout de métadonnées natives sans réécriture.
- **Compatibilité OAuth MCP** : l’inscription dynamique confidentielle conserve l’identité du client pour l’échange du code et le renouvellement. Les options avancées acceptent un client ID, un nom de variable du secret, une URL de métadonnées et des scopes. Les serveurs personnalisés et les cartes Linear/Notion sont conservés.
- **Avertissement abonnement Anthropic** : confirmation explicite de l’identité Claude Code et du risque de restriction du compte avant la connexion. Le formulaire de clé API reste distinct.
- **Fiabilité du démarrage et de la Roadmap** : les processus enfants isolés n’héritent plus des loaders d’une ancienne installation Studio. Les refus temporaires d’accès aux fichiers Windows sont réessayés lors des sauvegardes Roadmap, sans retirer les contrôles de chemin ni masquer les erreurs persistantes.
- **Comportement préservé** : pas de nouvel agent délégué d’analyse de captures, pas d’installation ni de redémarrage automatiques, aucun changement de l’autorisation ou de l’arrêt Bureau expert. Les gains annoncés en amont ne sont pas des mesures Studio.

## 3.8.1

- **Connexion par abonnement Muse Code (expérimentale)** : fournisseur `muse-code` séparé, par code dans le navigateur, sans clé API et sans installation du CLI. Exige un abonnement actif et échoue sans repli vers un usage payant.
- **Consentement explicite avant connexion** : le parcours Connecter affiche l’avertissement expérimental et exige la case de confirmation avant toute demande de connexion. La case reste compacte et alignée sur la première ligne du texte, sur PC comme sur écran étroit.
- **Aucun changement silencieux de facturation** : tant qu’un modèle de secours moteur est configuré, une session Muse refuse de démarrer au lieu de changer de facturation en cas de quota ou de panne. Videz le secours moteur pour utiliser Muse. Ce garde-fou couvre le démarrage des sessions par le Studio.
- **Docs et tests** : guides fournisseurs mis à jour en français et en anglais, avec couverture unitaire et UI du fournisseur filtré.

## 3.8.0

- **Une seule fenêtre de bureau** : les préférences, les mises à jour et la récupération utilisent la fenêtre principale, même si le serveur est arrêté ou utilise encore une ancienne interface.
- **Des actions distinctes** : vérifier les mises à jour, mettre à jour Studio, réparer les composants manquants et redémarrer le serveur ont chacun leur rôle. Une réparation ne redémarre pas implicitement le serveur.
- **Progression réelle et annulation** : les étapes, octets reçus, totaux connus, durée et erreurs restent disponibles à la réouverture du panneau. Une opération interrompue ne laisse plus l’interface bloquée indéfiniment.
- **Redémarrage explicite du serveur** : confirmez l’interruption des agents actifs et des opérations annulables. Le redémarrage attend la fin de l’annulation, vérifie l’identité du serveur et refuse d’arrêter un processus étranger. Le passage à l’installateur ne peut pas être annulé.
- **Quitter arrête le serveur** : « Quitter l’application » depuis la zone de notification arrête le serveur Studio vérifié avant de fermer. La croix masque toujours la fenêtre et laisse les agents travailler.
- **Meta Model API** : connectez Muse Spark avec une clé API, sans le CLI Muse Code. Les réglages personnalisés sont préservés. Le modèle Contributor signale que les requêtes et réponses peuvent servir à l’entraînement ; les accès et la facturation restent gérés par Meta.
- **Interface française et anglaise** : confirmations, messages de récupération et panneaux de mise à jour plus clairs sur PC et mobile. Projets, comptes et historique des conversations sont préservés.

## 3.7.1

- **Reprise après les outils** : rétroportage du correctif amont Prime Agent #2372 dans les nouveaux environnements Python gérés par Studio. La consommation d’un résultat `bash()` retire sa notification avant la fin de la cellule, pour éviter une interruption de la continuation. Empreinte dédiée, contrôle de compatibilité et validation du protocole avant utilisation. Les environnements déjà utilisés et les Python externes ne sont pas modifiés.
- **Activité plus explicite** : la fin d’un tour sans fin de session affiche un état d’attente distinct de la génération. Une nouvelle activité réactive l’indicateur. Aucun succès implicite, aucune fermeture anticipée de la session, des sous-agents ou des tâches de fond.
- **Déploiement prudent** : moteur maintenu en 0.9.5. Les sessions déjà actives restent sur leur environnement actuel ; le correctif Python s’applique aux nouveaux noyaux après activation de cette version du Studio. Ce correctif ne traite pas l’erreur Codex `Previous response not found`.

## 3.7.0

- **Migration du moteur vers Prime Agent 0.9.5** : politique épinglée (npm 10.9.4 et uv 0.8.22 inchangés), explication unique pour les utilisateurs venant d'une version < 3.7.0. Après la mise à jour de l'application, préparez puis activez la version 0.9.5 depuis **Préférences → Mise à jour** ; le téléchargement exige votre accord, et l’activation peut redémarrer le serveur géré uniquement quand les agents sont inactifs. Comptes et sessions conservés. Secours natif conservé si le serveur est arrêté ou ancien.
- **Parcours de mise à jour** : composants intégrés aux Préférences, préparation puis activation distinguées avec reprise sans retéléchargement, opérations sérialisées et aucun arrêt automatique des agents actifs. Installations externes explicitement validées réactivables sans faux reçu de téléchargement.
- **Modèles avancés unifiés** : même sélecteur commun avec recherche, fournisseurs et choix « Défaut du moteur », sans changer le modèle de la conversation. Réglages d'affinage, de secours et de sous-agent natif avec budgets autonomes par défaut, sans activation implicite.
- **Conversation et suivi** : messages inter-agents 0.9.5 et anciens formats, progression et dernière activité des sous-agents, états d'attente, de secours et de restauration du fournisseur. Relais en direct ordonné avec limite mémoire explicite, sans rejouer l'historique. En-tête du message utilisateur en miroir de l'assistant — heure à gauche, « Vous » avec avatar à droite.
- **Authentification explicite** : résolution par environnement puis stockage natif, sans import silencieux des comptes du CLI. Parcours Grok OAuth et clé API conservés.

## 3.7.0-beta.2

- Composants intégrés aux Préférences, indication du moteur requis et guide après mise à jour de l’application. Secours natif conservé pour un serveur arrêté ou ancien.
- Préparation et activation distinguées ; composants validés conservés, erreurs d’activation explicites et journalisées, reprise sans retéléchargement.
- Préparation, mise à jour de l’application et redémarrage sérialisés ; aucun arrêt automatique des agents actifs.
- Installations externes explicitement validées réactivables sans faux reçu de téléchargement ; contrôles des installations gérées préservés.
- Modèles avancés unifiés avec le sélecteur commun : recherche, fournisseurs et choix « Défaut du moteur », sans changer le modèle de la conversation.
- Migration expliquée une seule fois pour les utilisateurs venant d’une version < 3.7.0 : explication FR/EN, préparation puis activation de la version 0.9.5, sans installation ni redémarrage automatiques, comptes et sessions conservés.
- Conversation : en-tête du message utilisateur en miroir de l’assistant — heure à gauche, « Vous » avec avatar à droite, au-dessus de la carte.

## 3.7.0-beta.1

- **Packaging guidé** : politique épinglée sur Prime Agent **0.9.5** (npm 10.9.4 et uv 0.8.22 inchangés), avec les trois dépendances `@earendil-works` vérifiées contre le même inventaire officiel.

- **Relais en direct** : les événements du worker restent ordonnés lorsque le tampon interne se remplit, avec une limite mémoire explicite et sans rejouer l’historique.
- **Runtime natif** : API Python `rlm.spawn(..., name=...)`, notes `rlm.progress_note(...)` et entrée Node directe du moteur pour préserver les hooks et l’identité du superviseur.
- **Réglages avancés** : modèles d’affinage, de secours et de sous-agent natif ; budgets autonomes par défaut. Aucun secours ni mode autonome activé implicitement. Sauvegardes, verrou natif et détection des modifications concurrentes conservés.
- **Authentification** : résolution par environnement puis stockage natif, sans import silencieux des comptes du CLI. Parcours Grok OAuth et clé API conservés.
- **Conversation et suivi** : messages inter-agents 0.9.5 et anciens formats, progression et dernière activité des sous-agents, états d’attente, de secours et de restauration du fournisseur.

## 3.6.1

- **Publication Windows** : nettoyage des fichiers temporaires du test de redémarrage avec reprises bornées après la fermeture du processus.

## 3.6.0

- **Lecture pendant le streaming** : remonter dans la conversation détache le suivi automatique. Revenir en bas ou utiliser le bouton de retour réactive le suivi, sans interrompre la réponse.
- **Progression par plan** : un pourcentage discret complète le compteur de tâches. Les cases terminées sont vertes ; les groupes partiellement terminés conservent leur couleur.
- **Reste à faire uniquement** : filtre réversible des tâches terminées dans les plans et le backlog, sans modifier les données ni les pourcentages. Les parents, notes et plans restent accessibles.
- **Précisions avant délégation** : champ facultatif d’instructions complémentaires, transmis à une nouvelle conversation ou à la file de la conversation active. La saisie est conservée lors d’un conflit de révision.
- **Validation** : tests unitaires et tests navigateur isolés, avec streaming simulé et contrôles de la roadmap sur PC et petits écrans.

## 3.5.0

- **Ouverture prioritaire** : écran de connexion dans la fenêtre principale, réutilisation immédiate du serveur actif et contrôle léger des composants au démarrage à froid. Le diagnostic complet affiche ses étapes et reste disponible à la demande.
- **Ordre stable des conversations** : les nouveaux messages ne déplacent plus les conversations. Les épinglées restent en haut ; déplacement par menu, clavier et glisser-déposer dans le même projet. Les nouvelles conversations apparaissent en tête de leur groupe.
- **Imports plus discrets** : conversations importées marquées lues, mention « importé » retirée à la première ouverture ou après trois minutes, sans bandeau jaune. Modèle historique conservé s’il est utilisable, sinon modèle par défaut configuré du PC ; choix manuel seulement si aucun modèle utilisable n’est disponible.
- **Validation** : revues de code, compilation native et vérifications isolées. Le temps total d’ouverture sur l’installation réelle et le parcours tactile complet restent à vérifier ; aucune suite de tests relancée pour cette publication.

## 3.4.1

- **Correctifs d’export .pastudio (fichier transférable, opération sur le PC lui-même)** : fichier transférable et importable sur un autre PC ; export et import depuis le Studio ouvert sur ce PC, pas depuis un navigateur distant (LAN/Tailscale/PWA). Compression sélective ZIP DEFLATE (niveau 6, seulement si plus petit, sinon stockée, en séquence avec repli stocké) ; tolérance de fork à l’export — l’identifiant canonique est `header.id`, le nom du fichier reste le chemin physique, seuls les doublons du même identifiant canonique via des fichiers physiques différents sont refusés ; code d’erreur d’origine préservé avec détail générique borné.
- **Limites inchangées et compatibilité** : archive compressée limitée à 128 Mio assortie côté serveur et interface, total non compressé 256 Mio et 128 Mio par entrée inchangés, une seule opération à la fois. La limite 128 Mio demeure, ce n’est pas de l’illimité. Une archive de plus de 64 Mio exportée en 3.4.1 ne peut pas être importée en 3.4.0 : mettez à jour les deux instances.
- **Contenu inchangé** : fichiers du projet, réglages, clés des fournisseurs, mémoires et moteur jamais inclus ; aucun traitement en flux — l’export reste en mémoire, séquentiel.
- **Validation honnête** : revue indépendante approuvée et aller-retour export/décodage sur projets réels avec empreinte identique par fichier (Vtrott 178 Mo → 88 Mo, PrimeAgentGUI 75 Mo → 30 Mo) ; import réel et reprise live non revendiqués.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.4.0

- **Archives .pastudio v1 (local uniquement)** : exportez un projet complet puis importez-le dans un autre projet existant, sur cet appareil uniquement. Contenu transféré : conversations complètes avec sous-agents et Roadmap du projet. Les fichiers du projet, les réglages, les clés des fournisseurs, les mémoires et le moteur ne sont jamais inclus.
- **Import additif sans écrasement** : sessions et Roadmap existantes conservées ; vision locale inchangée (vision source en note de backlog). Réimporter la même archive est détecté et ignoré par empreinte ; si la source a changé, de nouvelles copies sont créées vers le nouveau dossier, jamais de fusion.
- **Reprise explicite** : l’historique reste lisible, mais la prochaine exécution d’une session importée exige un modèle disponible choisi explicitement ; aucun modèle historique n’est réappliqué.
- **Secrets et reprise** : les historiques peuvent contenir des secrets — vérifiez avant de partager un fichier. Un import interrompu reste en attente et se relance sans doublon.
- **Limites validées** : revue source ACCEPT et fixtures isolées OK ; validation physique à deux PC et reprise live non revendiquées.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.3.3

- **Composants durcis** : hôtes de téléchargement fixes sans héritage de `NODE_OPTIONS`, reprise avec reçu vérifié, moteurs externes non exécutés sans sélection explicite, état du lanceur préservé après annulation, avertissement catalogue affiché après interruption.
- **Signature sécurisée** : les workflows ne signent jamais un installateur téléversé ; ils reconstruisent l’installateur depuis le tag avant signature.

## 3.3.2

- **Composants plus compacts** : état et versions sur une ou deux lignes. Le bouton Détails affiche les chemins, les sources de téléchargement et les options avancées ; cette zone est fermée par défaut.
- **Actions adaptées** : le bouton d’installation disparaît lorsque tout est prêt. La progression et les erreurs restent visibles.

## 3.3.1

- **Installation guidée corrigée** : les dépendances de Prime Agent sont installées depuis le dossier du moteur, quel que soit le dossier de lancement de Studio. Corrige l’échec de préparation dans l’application Windows installée. Les composants déjà validés sont réutilisés.
- **Validation** : installation complète testée avec le Node embarqué depuis un dossier sans `package.json`, comme dans l’application installée.

## 3.3.0

- **Installation guidée** : préparation de Prime Agent, uv et Python au premier lancement ou depuis les réglages, après un clic explicite. Réutilisation des installations compatibles, progression, annulation et reprise après échec.
- **Compatibilité du moteur** : Studio 3.3.0 cible Prime Agent 0.9.4. Une future version de Studio pourra demander sa mise à niveau ; aucun téléchargement automatique en arrière-plan.
- **Roadmap visible** : bouton complet dans la barre supérieure avec le pourcentage d’avancement du projet, actualisé même lorsque le panneau est fermé.
- **Configuration plus claire** : avertissement si aucun fournisseur n’est configuré ou aucun modèle n’est sélectionné ; correction de l’alignement et de la couleur du sélecteur de réflexion des sous-agents.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.2.7

- **Connexion optionnelle par clé d’accès** : enregistrement depuis Préférences → Accès distant sur l’adresse HTTPS Tailscale du téléphone. Validation par biométrie ou code de déverrouillage ; le code Studio reste disponible. Gestion et révocation des clés depuis le PC. Changer le code Studio invalide les clés existantes.
- **Interface tablette plus compacte** : barre supérieure réduite, mention redondante sous le champ de saisie et fausse version du panneau Session supprimées.
- **Questions en attente** : un point d’interrogation ambre près d’Espace de travail permet d’ouvrir une conversation en attente de réponse.
- **Activité roadmap** : texte et indicateur en cours en bleu pulsant, avec respect de la réduction des animations.
- **Après installation** : redémarrez le serveur dans Préférences → Mise à jour une fois les agents terminés.

## 3.2.6

- **Mises à jour sur mobile** : bouton permanent pour relancer la recherche et contourner le cache. Le bouton redevient disponible après une erreur ou un délai dépassé ; les erreurs de demande d’installation sont visibles dans le panneau mobile.
- **Questions dans le fil** : la question interactive et sa réponse restent à la position de leur appel d’outil pendant que les messages suivants arrivent, au lieu de rester en bas de la conversation jusqu’à la fin du tour.
- **Après installation** : redémarrez le serveur depuis les préférences, une fois les agents terminés.

## 3.2.5

- **Questions interactives** : les demandes natives restent transmises pendant une resynchronisation ou une saturation du flux du moteur, au lieu d’être écartées avec les événements d’affichage.
- **Notifications sonores** : son système activé sur Windows ; notifications PWA non muettes, selon les réglages du téléphone. Les règles de focus et les préférences Windows sont conservées.
- **Application du correctif** : après installation, redémarrez le serveur du Studio une fois les agents terminés.

## 3.2.4

- **Quota et contexte aussi à distance (authentifié)** : le quota Codex et le contexte de session restent consultables depuis l’accès mobile authentifié, via des endpoints limités et assainis. Actualisation manuelle uniquement, compte Codex lié (OAuth) requis ; le contexte affiche un état honnête quand la mesure est indisponible.
- **Notifications mobiles PWA (optionnel, par appareil)** : **Préférences → Notifications → Notifications mobiles** active les alertes **Questions** et **Fins de tour** sur cet appareil, même PWA fermée. Inscription Web Push VAPID par appareil, texte générique uniquement, désactivée par défaut. Prérequis : PWA installée depuis l’adresse HTTPS Tailscale, notifications autorisées, PC allumé et Tailscale connecté des deux côtés. Sur iPhone/iPad : iOS 16.4+, Safari, Partager → Sur l’écran d’accueil, puis ouvrir depuis l’icône. [Guide PWA](pwa.md).
- **Mise à jour à distance via le PC** : depuis l’accès distant, **Préférences → Mise à jour** affiche la version publiée et permet de demander l’installation sur le PC. Le PC télécharge, vérifie la signature puis installe via sa mise à jour native signée ; la demande est refusée si des agents sont actifs ou si l’accès est en lecture seule. Notes de version affichées en markdown assaini.
- **Limites validées** : push sur appareil physique et mise à jour distante réelle de bout en bout non validés.

## 3.2.3

- **Activité des conversations dans la Roadmap** : chaque élément affiche **En cours · …**, avec un compteur **+N** pour déplier les autres conversations. L’activité apparaît aussi sous chaque tâche et mène à sa conversation.
- **Champ Réflexion des sous-agents** : l’étiquette et la liste restent alignées et pleine largeur avec le sélecteur de modèle, sans chevauchement.
- **Quota Codex (optionnel)** : pour les modèles OpenAI/Codex, un bloc avec barres courte et hebdomadaire et bouton **Actualiser le quota**. Consultation manuelle uniquement, compte Codex lié (OAuth) requis ; les modèles via clé API affichent une note sans quota. Indisponible depuis l’accès distant.
- **Contexte Prime Agent** : la session affiche **X / Y jetons (Z %)** avec barre, depuis le contexte actuel natif, jamais le total cumulé. Masqué quand indisponible.

## 3.2.2

- **Notifications Windows rétablies** : correction d’un plantage à l’initialisation qui empêchait le suivi des questions et des fins de tour de démarrer. Les préférences de notification et le silence lorsque le Studio a le focus sont conservés.
- **Questions en attente visibles** : un **?** ambre remplace le point vert d’activité dans la liste des conversations et sur leur projet, y compris lorsqu’il est replié. La vue du projet indique également **Question en attente**.
- **Brouillons après envoi** : le texte accepté est effacé même si vous changez de conversation avant la fin de l’envoi, y compris pour les messages transmis à un agent déjà actif. Un nouveau brouillon saisi entre-temps reste conservé ; un envoi échoué ne l’efface pas.

## 3.2.1

- **Questions autorisées par défaut** : choisissez la valeur initiale dans **Préférences → Modèles et agents**. Le défaut est partagé par les appareils connectés au PC, tandis que chaque conversation conserve son choix enregistré.
- **Notifications Windows** : deux interrupteurs indépendants pour les questions en attente et les fins de tour, dans **Préférences → Notifications**. Les erreurs suivent le réglage de fin de tour ; les arrêts manuels restent silencieux.
- **Discrétion au premier plan** : aucune notification lorsqu’une fenêtre du Studio a le focus. Les événements silencieux ne sont pas rejoués après un changement de focus. Le suivi continue lorsque la fenêtre est masquée, tant que l’application reste ouverte.
- **Choix préservés** : un chargement reçu en retard ne remplace pas un nouveau défaut déjà enregistré. [Guide de configuration](configuration.md#notifications-windows).

## 3.2.0

- **Images dans les réponses de l’agent** : affichez les images du projet dans la conversation et cliquez pour les agrandir. Le Studio lit le fichier d’origine sans copie supplémentaire ; une image déplacée ou supprimée apparaît comme indisponible. Disponible sur PC et via l’accès mobile authentifié.
- **Questions interactives natives** : activez **Autoriser les questions** par conversation. Sélectionnez une réponse proposée, écrivez la vôtre ou passez. Les questions utilisent le mécanisme natif de demande et de réponse de Prime Agent, reprennent l’agent en attente et se synchronisent entre appareils connectés.
- **Précisions à la demande** : chaque choix possède une courte description, repliée par défaut. Le bouton **Passer** reçoit un contour discret. Le chargement des images et l’arrivée des questions préservent votre position de lecture.
- **Documentation illustrée** : les captures des README français et anglais présentent les deux fonctions dans une conversation fictive autour d’une Lotus Elise. [Guide de configuration](configuration.md#questions-interactives-et-images-dans-la-conversation).

## 3.1.4

- **Tout replier ou tout déplier** dans chaque plan de la Roadmap. Le plan reste ouvert, avec ses tâches principales et leurs compteurs visibles.
- **Modèle et réflexion propres à chaque conversation** : les choix sont enregistrés et retrouvés après rechargement ou depuis un autre appareil. Un ancien historique reçu en retard ne peut plus écraser une modification confirmée.
- **Changer la réflexion pendant le travail de l’agent** : le nouveau niveau s’applique aux prochains appels du modèle, sans interrompre l’outil en cours ni modifier les réglages globaux. Le modèle reste modifiable entre deux exécutions. [Guide de configuration](configuration.md).

## 3.1.3

- **Sélection de dossier Windows corrigée** : le sélecteur natif est rattaché à la fenêtre Tauri. La sélection ou l’annulation permet un nouvel essai ; fermer le formulaire dans le navigateur annule sa sélection en cours et préserve les nouveaux champs saisis.
- **Ouvrir le dossier du projet** directement depuis l’onglet **Fichiers** de l’espace de travail, à côté d’**Actualiser**. L’accès distant indique clairement le PC hôte ; l’accès en lecture seule ne peut pas ouvrir de dossier.

## 3.1.2

- **Roadmap agrandie** : ouvrez une vue sur tout l’espace de travail, puis retrouvez le panneau latéral avec le bouton de réduction ou Échap.
- **Listes compactes** : repliez les catégories et les tâches parentes en gardant leur compteur de tâches terminées sur le total en bout de ligne. Les descriptions sont masquées par défaut et s’ouvrent avec **Afficher la description**.
- **Lecture préservée** : les replis restent en place pendant les actualisations. Les contrôles s’adaptent au clavier et au téléphone. [Guide Roadmap](roadmap.md).

## 3.1.1

- **Les tests MCP dans l’application Windows** retrouvent désormais Python dans le dossier persistant de l’application, y compris après une mise à jour. Si Python n’a pas encore été préparé, le Studio le configure automatiquement avant de découvrir les outils. [Guide MCP](mcp.md).

## 3.1.0

- **Roadmap du projet** : organisez jalons, plans, checklists imbriquées et backlog dans un panneau partagé sur PC et téléphone.
- **Du plan à la conversation** : choisissez **Travailler dessus** pour démarrer ou poursuivre un travail avec Prime Agent. Suivez l’activité déclarée des agents et retrouvez les conversations liées, y compris l’historique des sous-agents.
- **Outils natifs pour les agents** : six outils utilisent le même document du projet que l’interface. Les contrôles de révision protègent les modifications simultanées et les brouillons restent récupérables après un conflit. Ouvrir le panneau ne lance aucun appel de modèle.
- **Connaissances du projet accessibles** : consultez les mémoires et refinements natifs depuis le panneau, ou exportez la Roadmap en Markdown. [Guide Roadmap](roadmap.md).

## 3.0.1

- **Catalogue natif Prime Agent 0.9.4** : le Studio utilise les modèles disponibles dans le registre du moteur installé, avec leurs niveaux de réflexion. Le bouton d’actualisation du sélecteur permet de recharger le catalogue.
- **Disponibilité OpenRouter** : les modèles retirés du catalogue public sont signalés comme indisponibles. Une variante gratuite disparue reste distincte de son équivalent payant ; aucun remplacement automatique n’est effectué. Les connexions à des endpoints personnalisés sont conservées.
- **Choix préservés** : actualiser conserve la sélection, les favoris, la recherche et le brouillon. En cas de panne réseau, le catalogue reste consultable et une nouvelle tentative est possible. [Guide des fournisseurs](providers.md).

## 3.0.0

- **Projets et conversations réunis** : les conversations apparaissent sous leur projet dépliable, dans une seule liste, avec les projets épinglés en tête et **Afficher plus** pour les sessions anciennes. Recherche, archives, indicateurs de non-lus et réorganisation des projets restent à portée de main. Replier un projet conserve la conversation active et son brouillon ouverts. Sur téléphone, toucher le nom d’un projet le déplie ou le replie en gardant le volet ouvert ; choisir une conversation le referme. Les actions d’une conversation s’ouvrent aussi par clic droit sur PC. [Guide de navigation](navigation.md).
- **Connaissances du projet** : retrouvez les travaux passés depuis **Session** dans le panneau de droite, la vue du projet ou son menu **⋯**. Recherchez du texte, filtrez les résultats et consultez la source native exacte, avec un lien vers la conversation d’origine lorsqu’il est disponible. La consultation fonctionne aussi sur téléphone et en accès distant authentifié en lecture seule. [Guide des connaissances](knowledge.md).
- **Mémoires et refinements natifs** : consultez les mémoires de session et les modifications avant/après enregistrées. Les éléments globaux portent la mention **Global** et restent partagés entre projets par Prime Agent. La consultation laisse les données natives intactes.
- **Outils d’historique pour les agents** : les nouvelles exécutions du Studio et leurs sous-agents peuvent rechercher et lire les sources utiles du projet à la demande. La recherche textuelle ne sollicite aucun modèle et un cache local évite de relire les conversations inchangées. L’historique complet n’est pas ajouté automatiquement au contexte de l’agent.

## 2.9

- **Mises à jour depuis les préférences en 2.9.3** : **Préférences → Mise à jour** affiche les versions de l’application et du serveur, les nouveautés et l’installation signée. Le redémarrage du serveur est optionnel ; des agents actifs demandent confirmation. Les réglages près de l’horloge conservent ces contrôles lorsqu’un ancien serveur tourne encore.
- **Correctifs Windows 2.9.3** : les liens web et la connexion Codex s’ouvrent dans le navigateur habituel ; les fichiers et images peuvent être déposés dans la conversation. Les réponses terminées vides sont masquées sans modifier l’historique natif.
- **Correctif 2.9.2** : les préférences système et le diagnostic lisent la version dans les métadonnées du serveur empaqueté. La version 2.9.0 affichait à tort 2.8.1 même lorsque son nouveau serveur fonctionnait. Un ancien serveur toujours actif continue d’indiquer sa propre version jusqu’à son redémarrage.
- **Messages d’agents** : aperçus compacts et repliés, avec le nom de l’expéditeur. Un clic ouvre le message complet et ses détails de transmission. Les messages automatiques en attente sont clairement identifiés et protégés contre la modification ou la suppression.
- **Ordre des projets** : glissez les projets directement dans la liste à la souris, ou utilisez la poignée sur écran tactile. L’ordre est conservé entre les appareils.
- **Non-lus partagés** : lire une réponse sur PC efface son indicateur sur le téléphone et inversement, y compris en accès distant en consultation.
- **Sessions Codex longues** : renouvellement des connexions WebSocket anciennes et inactives entre les requêtes, et suppression des états d’échec transitoires après une reprise native réussie. Les requêtes actives sont préservées.
- **Présentation sobre** : texte lisible et libellés discrets, sans liserés colorés. Rendu vérifié sur PC/mobile, en français/anglais et dans les thèmes clair/sombre.

## 2.8

- **Correctif 2.8.1** : l’installateur Windows inclut désormais les workers des messages, skills, fournisseurs et MCP, ainsi que les assistants de dossiers et fichiers. La mise à jour restaure aussi les fichiers absents du cache serveur 2.8.0 d’origine sans redémarrer ses agents.
- **Application Windows Tauri 2** : installateur pour votre utilisateur, raccourcis Bureau et Démarrer, Node.js inclus et icône nette adaptée à l’affichage Windows.
- **Travail en arrière-plan** : le raccourci démarre le serveur ou retrouve celui déjà actif. Fermer ou quitter l’application laisse les agents travailler. Le démarrage avec Windows est facultatif et désactivé par défaut.
- **Reprise et accès distant** : reprenez les projets et réglages d’une installation existante. Le LAN, Tailscale, HTTPS, les QR codes et la PWA mobile restent disponibles.

[Installation, reprise des données et mises à jour](desktop.md).

## 2.6

- **Dossier du projet** : dans **Un projet à explorer.**, **Choisir un dossier** ouvre le sélecteur Windows et remplit le chemin. Le nom saisi est conservé ; une annulation laisse le formulaire intact.
- **Skills et prompts** : les deux onglets de **Commandes et skills** proposent **Global · Tous les projets** ou **Projet sélectionné**, puis **Ouvrir le dossier**. Un dossier absent est créé à la demande.
- **Sur PC et à distance** : le sélecteur Windows est réservé au Studio local. L’ouverture des dossiers de ressources fonctionne aussi depuis un accès distant en contrôle complet et s’effectue sur le PC hôte.
- **Documentation bilingue** : README et guides disponibles en français et en anglais.

## 2.5

- **Français et anglais** : choix **Automatique / Français / English** dans les préférences et sur la page de connexion mobile, avec détection de la langue du navigateur.
- **Changement immédiat** : les conversations, brouillons, pièces jointes et formulaires restent intacts ; une réponse en cours continue. Les onglets d’une même adresse partagent le choix de langue.
- **Une table unique** : 1 051 textes regroupent leurs traductions côte à côte. Les paramètres, pluriels et références sont contrôlés automatiquement ; une traduction absente ou vide utilise le français.
- **Mobile et PWA** : connexion, erreurs, déconnexion, informations d’installation et écran hors connexion suivent la langue choisie.
- **De nouvelles langues à ajouter** : [le guide de traduction](translations.md) explique comment compléter la table et vérifier l’interface.
