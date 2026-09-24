# Connexions MCP

[English](en/mcp.md) · **Français** · [← Retour au README](../README.fr.md)

Ouvrez **Préférences → Outils → Gérer les MCP**, sur le PC ou dans le Studio distant en contrôle complet. Le gestionnaire utilise la configuration native de **Prime Agent 0.9.1** : les connexions sont communes aux projets du PC.

## Ajouter une connexion

Choisissez **Ajouter un MCP**, donnez-lui un nom unique, puis sélectionnez son transport.

| Transport | Configuration                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP**  | L’adresse du point d’accès MCP, par exemple `https://service.example/mcp`. Authentification sans identifiant, par jeton direct (secret enregistré comme en-tête privé), par variable contenant un jeton Bearer, ou avec OAuth. |
| **stdio** | L’exécutable installé sur le PC, ses arguments — un par ligne, sans guillemets de shell — et, si nécessaire, son dossier de travail absolu.                          |

Un serveur stdio fonctionne sur le **PC qui héberge Prime Agent**, même si vous le configurez depuis votre téléphone. L’enregistrement ne l’exécute pas. Le bouton **Tester** le lance dans un processus distinct et masqué sous Windows, puis le ferme après la découverte des outils. Installez d’abord l’exécutable requis sur le PC ; le Studio ne télécharge pas de serveur à votre place.

Pour une variable d’environnement, saisissez son **nom**, pas sa valeur : `MON_SERVICE_TOKEN` pour HTTP, ou `TOKEN=MON_SERVICE_TOKEN` dans la zone stdio. La variable doit être disponible dans l’environnement du processus Studio et des nouvelles sessions Prime Agent. Une variable définie après leur lancement peut nécessiter un redémarrage, à effectuer une fois les agents terminés. Le nom des variables absentes est affiché dans la liste. Si vous collez un jeton par erreur dans ce champ, le gestionnaire vous propose de basculer sur le mode **Jeton direct**.

Le mode **Jeton direct** enregistre le secret comme en-tête HTTP `Authorization: Bearer` privé : il n’est jamais réaffiché ni renvoyé au navigateur. Laissez le champ vide lors d’une modification pour conserver le secret. Les paramètres d’adresse éventuels (par exemple `?read_only=true&project_ref=…` chez Supabase) restent privés et conservés tant que l’adresse affichée ne change pas.

Les options avancées permettent de définir les délais de démarrage et d’appel, une liste d’outils autorisés, une liste d’outils interdits et des en-têtes HTTP. La restriction à une liste vide n’autorise **aucun outil**. Sans restriction, tous les outils sauf ceux interdits restent disponibles.

## Tester et gérer

**Tester** utilise le véritable client MCP du moteur Python de Prime Agent. Il initialise la connexion et récupère le catalogue, avec les noms, descriptions et schémas des outils autorisés. Il n’appelle aucun outil métier. Un test réussi confirme la connexion et la découverte à cet instant ; les autorisations d’un appel ultérieur peuvent différer.

Dans l’application Windows, le test retrouve le Python du dossier persistant, conservé entre les mises à jour. S’il n’existe pas encore, le Studio le prépare automatiquement avec Prime Agent et uv ; ce premier test peut donc prendre plus de temps. Aucune commande manuelle de préparation n’est nécessaire. Une configuration Python explicitement définie reste prioritaire.

Vous pouvez rechercher, modifier, activer, désactiver ou supprimer les serveurs ajoutés. Une suppression demande confirmation et retire aussi les identifiants OAuth de ce seul serveur. Linear et Notion sont les intégrations natives de Prime Agent : connectez-les ou déconnectez-les depuis leur carte. Leurs noms sont réservés.

Les nouveaux réglages s’appliquent aux **nouvelles sessions**. Les sessions déjà chargées conservent leur configuration jusqu’à leur rechargement natif ; le Studio ne les interrompt pas pour appliquer un changement. Pour essayer immédiatement une connexion ajoutée, ouvrez une nouvelle session et demandez à Prime Agent d’utiliser ce MCP.

## Se connecter avec OAuth

Pour un serveur HTTP compatible OAuth, choisissez **Connecter**, puis **Autoriser dans le navigateur**. Prime Agent réalise la découverte du serveur d’autorisation, l’enregistrement dynamique du client et l’échange sécurisé avec PKCE.

- **Sur le PC** : le retour vers le serveur local de Prime Agent est automatique.
- **Sur un téléphone** : après l’autorisation, le navigateur peut aboutir à une adresse `http://localhost:5370…/callback?…` inaccessible. Copiez cette **adresse complète**, revenez dans le gestionnaire MCP, collez-la dans **Adresse complète de retour** et validez. Le Studio vérifie qu’elle correspond à la connexion en cours.

Vous pouvez annuler la connexion ; elle expire après trois minutes. Les serveurs exigeant un identifiant de client OAuth préenregistré ne sont pas pris en charge par le formulaire, conformément aux options persistantes exposées par Prime Agent 0.9.1. Utilisez une authentification par jeton si le service la propose.

Certains serveurs (Supabase, par exemple) délivrent à l’enregistrement dynamique un client **confidentiel** avec secret : l’échange du code puis le renouvellement exigent ce secret, que le moteur OAuth actuel ne conserve pas. La connexion échoue alors après le retour du navigateur, et le gestionnaire affiche désormais le motif réel au lieu d’un message générique. Dans ce cas, utilisez le mode **Jeton direct** avec un jeton d’accès personnel du service.

## Configuration et confidentialité

Le gestionnaire modifie uniquement `mcpServers` dans `~/.prime/agent/settings.json`, sous le verrou de fichiers natif de Prime Agent. Il préserve les valeurs par défaut des modèles et les autres réglages. Si une autre fenêtre modifie le même serveur, l’écriture est refusée et il faut recharger la liste.

Les identifiants OAuth sont enregistrés par Prime Agent dans `~/.prime/agent/auth.json`, sous la clé `mcp:nom-du-serveur`. Les comptes de modèles restent séparés. Les jetons OAuth, les valeurs d’en-têtes enregistrées et les paramètres privés d’URL ne sont pas renvoyés à l’interface. Lors d’une édition, une valeur d’en-tête `null` signifie **conserver la valeur existante**. Changer d’adresse impose de remplacer ou retirer les en-têtes privés conservés ; les anciens identifiants OAuth sont retirés pour ce serveur.

La gestion MCP est disponible via les passerelles authentifiées en **contrôle complet**. Elle reste inaccessible en lecture seule. Les tests et les autorisations OAuth utilisent leurs propres processus ; ils ne ferment pas les agents en cours.
