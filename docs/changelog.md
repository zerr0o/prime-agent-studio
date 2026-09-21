# Historique des versions

[English](en/changelog.md) · **Français** · [← Retour au README](../README.fr.md)

Les changements par version. Retrouvez les installateurs et les archives du code source dans les [releases GitHub](https://github.com/zerr0o/prime-agent-studio/releases).

## 3.7.1

- **Reprise après les outils** : rétroportage du correctif amont Prime Agent #2372 dans les nouveaux environnements Python gérés par Studio. La consommation d’un résultat `bash()` retire sa notification avant la fin de la cellule, pour éviter une interruption de la continuation. Empreinte dédiée, contrôle de compatibilité et validation du protocole avant utilisation. Les environnements déjà utilisés et les Python externes ne sont pas modifiés.
- **Activité plus explicite** : la fin d’un tour sans fin de session affiche un état d’attente distinct de la génération. Une nouvelle activité réactive l’indicateur. Aucun succès implicite, aucune fermeture anticipée de la session, des sous-agents ou des tâches de fond.
- **Déploiement prudent** : moteur maintenu en 0.9.5. Les sessions déjà actives restent sur leur environnement actuel ; le correctif Python s’applique aux nouveaux noyaux après activation de cette version du Studio. Ce correctif ne traite pas l’erreur Codex `Previous response not found`.

## 3.7.0

- **Migration du moteur vers Prime Agent 0.9.5** : politique épinglée (npm 10.9.4 et uv 0.8.22 inchangés), explication unique pour les utilisateurs venant d'une version < 3.7.0. Après la mise à jour de l'application, préparez puis activez la version 0.9.5 depuis **Préférences → Mise à jour**  ; le téléchargement exige votre accord, et l’activation peut redémarrer le serveur géré uniquement quand les agents sont inactifs. Comptes et sessions conservés. Secours natif conservé si le serveur est arrêté ou ancien.
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
