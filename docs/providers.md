# Fournisseurs de modèles

[English](en/providers.md) · **Français** · [← Retour au README](../README.fr.md)

Sur le PC qui exécute le Studio, ouvrez **http://127.0.0.1:3088 → Préférences → Modèles et agents → Gérer les connexions**. Ce panneau est réservé à l’accès local du PC : il n’est pas disponible par le LAN, Tailscale ou la PWA distante, même en contrôle complet.

## Comptes et clés API

La liste utilise le catalogue de l’installation Prime Agent, avec une recherche par nom ou identifiant. Elle indique les modèles connus et l’origine de la configuration. **Configuré** signifie qu’un moyen d’authentification a été trouvé ; l’ouverture de ce panneau n’envoie pas de requête de génération pour vérifier un abonnement, un quota ou une clé.

- **Connecter un compte** lance le parcours natif du fournisseur. Ouvrez la page officielle avec le bouton proposé, autorisez la connexion et revenez au Studio. Selon le fournisseur, un code, un domaine ou un choix peut être demandé. Une saisie manuelle du code ou de l’adresse de retour est proposée quand le moteur la prend en charge.
- **Ajouter une clé API** enregistre une clé dans le stockage natif de Prime Agent. Une clé déjà enregistrée n’est jamais préremplie ni renvoyée au navigateur.
- **Variable d’environnement** enregistre le nom d’une variable existante dans l’environnement du serveur. La variable doit déjà être définie et non vide. Ce panneau ne modifie pas les variables système.

Avec Prime Agent 0.9.5, les parcours par compte sont ceux exposés par le registre natif : OpenAI Codex, Anthropic, GitHub Copilot et xAI (Grok). Le Studio ne maintient pas de liste figée et suit le moteur installé. Pour xAI, la même entrée `xai` accepte une connexion par compte (abonnement éligible) ou une clé API existante (`XAI_API_KEY`) ; les règles d’accès et de facturation restent celles du fournisseur, consultez la [documentation native des fournisseurs](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.5/packages/coding-agent/docs/providers.md).

En usage ordinaire, Prime Inference utilise `PRIME_API_KEY` puis l’entrée `auth.json` ; la configuration Prime CLI (`~/.prime/config.json`) n’est plus lue et n’est réutilisée que lors d’une connexion explicite en amont. Si vous ne dépendiez que de la CLI, reconnectez ce fournisseur (clé API existante prise en charge). Le Studio n’importe jamais silencieusement les identifiants CLI et n’ouvre réellement aucune connexion externe.

Azure et Cloudflare demandent des paramètres d’environnement complémentaires. Bedrock et Vertex utilisent leurs réglages cloud existants ; une indication dans leur carte explique où les configurer. Les fournisseurs personnalisés doivent d’abord être définis dans **Modèles et valeurs par défaut**.

## Catalogue et disponibilité

Avec Prime Agent **0.9.4**, le sélecteur utilise le registre natif des modèles disponibles pour les fournisseurs configurés. Son actualisation inclut les modèles publics et les modèles privés Prime Inference accessibles à votre compte. Si le moteur est plus ancien ou si ce registre est indisponible, le Studio utilise le catalogue intégré à l’installation et les modèles personnalisés. Avec Prime Agent **0.9.5**, la résolution ordinaire ne lit plus la configuration Prime CLI et le catalogue ne la surveille plus ; un instantané d’équipe CLI n’est réutilisé que lors d’une connexion explicite en amont, puis conservé par l’Agent sans suivre les changements CLI ultérieurs.

Pour **OpenRouter**, le Studio vérifie aussi les identifiants dans le catalogue public `https://openrouter.ai/api/v1/models`, avec un cache de cinq minutes. Cette consultation ne génère aucune réponse et ne vérifie ni vos crédits, ni votre quota, ni la capacité d’un modèle à répondre à cet instant. Une erreur réseau ne rend pas toute la liste indisponible. Cette vérification publique est ignorée lorsque vous configurez une adresse OpenRouter personnalisée.

Un modèle reconnu comme retiré reste visible avec la mention **Indisponible** et ne peut plus être sélectionné. Les anciens identifiants restent conservés dans l’historique et les valeurs par défaut. Choisissez un autre modèle pour continuer : le Studio ne remplace jamais automatiquement un identifiant gratuit retiré par sa version payante.

Le bouton **Actualiser les modèles**, près des favoris dans le sélecteur, relance la synchronisation du catalogue. Le Studio la demande aussi lorsqu’une exécution échoue avec une erreur de modèle indisponible. L’actualisation conserve votre sélection ; elle ne relance aucune génération.

## Déconnexion et sessions en cours

**Déconnecter** demande une confirmation, puis retire uniquement les identifiants enregistrés pour ce fournisseur dans `auth.json`. Les conversations, les modèles personnalisés, les connexions MCP et les autres fournisseurs restent en place. Les variables d’environnement et les paramètres de `models.json` ne sont pas supprimés : ils peuvent donc continuer à fournir un accès. La configuration Prime CLI n’est ni supprimée ni lue en usage ordinaire.

Pour Prime Inference, `PRIME_API_KEY` a priorité sur la clé enregistrée dans `auth.json`.

L’ajout d’un fournisseur reste possible pendant le travail des agents. Le remplacement ou le retrait d’identifiants existants attend la fin des exécutions du Studio. Les agents lancés dans un autre terminal partagent ces identifiants : attendez aussi la fin de leur travail avant de les remplacer ou de les retirer. Le panneau n’arrête aucune session et ne recharge aucun worker actif.

Après un enregistrement réussi, le catalogue de modèles du Studio est actualisé. Prime Agent reste responsable de l’utilisation et du renouvellement des identifiants. Fermer la fenêtre de connexion conserve le parcours OAuth en cours ; rouvrez **Fournisseurs** pour le retrouver. **Annuler la connexion** ferme seulement le processus de connexion. Un parcours inachevé expire au bout de cinq minutes.

## Stockage et accès

Les clés et jetons sont conservés sur le PC dans le fichier natif `~/.prime/agent/auth.json`. Les écritures utilisent le verrou natif de Prime Agent et vérifient que les identifiants du fournisseur n’ont pas été modifiés entre-temps. Une modification simultanée d’un autre fournisseur ou d’un MCP est conservée.

Les opérations s’exécutent dans un processus Windows masqué, indépendant des agents. Les clés et codes saisis ne sont pas placés dans les arguments de lancement, les journaux ou le stockage du navigateur. Les routes de gestion sont refusées par la passerelle distante ; masquer le bouton n’est pas la seule restriction.

Les tests automatiques emploient des fichiers temporaires et des clés factices. Le stockage natif et les restrictions d’accès sont vérifiés réellement ; les autorisations OAuth sont simulées pour ne connecter ni déconnecter aucun compte personnel.
