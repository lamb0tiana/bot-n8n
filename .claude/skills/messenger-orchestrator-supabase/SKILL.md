---
name: messenger-orchestrator-supabase
description: >
  Agent orchestrateur intelligent pour bot de vente Messenger avec recherche produits via Supabase MCP.
  Utilise ce skill lorsque tu dois : orchestrer un bot de vente Messenger, rechercher des produits dans
  une base Supabase, résoudre des références produit ambiguës ("le rouge", "celui-là", "même en bleu"),
  maintenir le contexte de conversation multi-tours, détecter l'intention d'achat d'un client,
  gérer la mémoire produit entre les messages, construire des payloads structurés pour un module Assistant,
  ou implémenter un orchestrateur type Make/n8n avec Supabase comme base produits.
  Déclenche aussi pour : bot vente Messenger, orchestrateur agent, résolution contexte produit,
  recherche vectorielle Supabase, gestion mémoire session, pipeline intention achat.
---

# Skill : Agent Orchestrateur Messenger × Supabase

## Vue d'ensemble

Ce skill implémente un agent orchestrateur pour bot de vente Messenger.
Il ne répond jamais directement au client — il analyse, résout le contexte,
recherche les produits via Supabase MCP, construit un payload structuré,
et délègue la rédaction de la réponse au module Assistant (dans Make/n8n).

---

## Architecture

```
Message client
    ↓
[ANALYSE] — Classifier le type (A/B/C/D)
    ↓
[RÉSOLUTION CONTEXTE] — Produit actif ? Référence résoluble ?
    ↓
[CHECKPOINT] — Search Supabase nécessaire ?
    ↓ (si oui)
[SEARCH SUPABASE] — Recherche vectorielle (texte ou image)
    ↓
[VALIDATION] — Validation renforcée des résultats
    ↓
[PAYLOAD] — Construire le payload structuré
    ↓
[MODULE ASSISTANT Make/n8n] — Déléguer la réponse
    ↓
[MISE À JOUR MÉMOIRE] — Mettre à jour la session
    ↓
Retourner la sortie brute SANS modification
```

---

## MCP Supabase — Configuration

```json
{
  "supabase": {
    "type": "http",
    "url": "https://mcp.supabase.com/mcp?project_ref=ymdngagxbpjqanczloyv"
  },
  "embedding-server": {
    "command": "node",
    "args": ["./index.js"],
    "env": {
      "OPENAI_API_KEY": "<votre_clé>"
    }
  }
}
```

Outils utilisés :

- `mcp__embedding-server__embed_text` — vectorisation des requêtes texte
- `Bash` + `curl` — appel POST à `/rest/v1/rpc/match_images` (REST API Supabase)
- `mcp__supabase__get_project_url` + `mcp__supabase__get_publishable_keys` — récupération des credentials

> Ne jamais utiliser de requête SQL directe (`execute_sql` ou autre).
> Toujours passer par POST `/rest/v1/rpc/match_images`.
> Voir `references/supabase-search.md` pour la procédure complète.

---

## Mémoire de session à maintenir

```
produit_actif             — dernier produit clairement identifié
produits_recents          — jusqu'aux 5 derniers produits envoyés
derniere_requete_produit  — dernière recherche explicite du client (catégorie + attributs extraits)
dernier_statut_recherche  — statut du dernier appel Supabase (produit_trouve | aucun_produit | produit_multiple)
dernier_resultat_recherche — liste brute retournée par le dernier appel Supabase (avec tous les produits et attributs)
produits_deja_envoyes     — liste des IDs déjà proposés
derniere_limite_recherche — dernière valeur de match_count utilisée
```

### Cycle de vie de produit_actif

**Devient** produit_actif si :

- client pose une question spécifique dessus (prix, taille, dispo)
- client exprime une intention d'achat
- recherche retourne `status = produit_trouve` sur ce produit

**Reste** produit_actif tant que :

- client ne mentionne pas un autre produit explicitement
- client ne lance pas une nouvelle recherche (TYPE A2)

**Perd** le statut si :

- client dit "pas celui-là", "non", "autre chose"
- nouvelle recherche A2 retourne `produit_trouve` sur un autre produit

---

## Étape 1 — Classification du message

| Type  | Description                                                       |
| ----- | ----------------------------------------------------------------- |
| **A** | Produit / intention d'achat (prix, dispo, couleur, taille, achat) |
| **B** | Demande générale (adresse, livraison, horaires, paiement)         |
| **C** | Image envoyée par le client (avec ou sans texte)                  |
| **D** | Message trop ambigu pour résolution fiable                        |

Sous-types TYPE A :

- **A1** — Référence à un produit en mémoire (ex : "c'est combien celui-là ?")
- **A2** — Nouvelle recherche explicite (ex : "je cherche un t-shirt rouge")
- **A3** — Demande de variantes / continuité (ex : "t'as pas autre chose ?")
- **A4** — Intention d'achat / confirmation (ex : "je le prends", "je veux commander")

---

## Étape 2 — Résolution des références produit

### Mécanisme (ordre strict)

1. Extraire les attributs : couleur, taille, pointure, prix, modèle, référence, matière
2. Parcourir la mémoire par priorité : `produit_actif` → `produits_recents` → `historique ancien`
3. Vérifier la correspondance avec les attributs extraits
   - **Si attribut = couleur ou taille** : croiser OBLIGATOIREMENT avec la catégorie active
     - Ex : "le rouge" + contexte = t-shirt → chercher t-shirt rouge, pas sac rouge
     - Si catégorie active inconnue → `clarification_requise`
4. 1 seul produit correspond → référence retenue
5. Plusieurs produits plausibles → `clarification_requise` OBLIGATOIRE (jamais de choix arbitraire)
6. Aucun produit en mémoire → utiliser `derniere_requete_produit` si elle existe
7. Aucune résolution fiable → TYPE D

### Cas particulier : résolution par prix

- Correspondance exacte uniquement (±0, pas d'arrondi)
- Plusieurs produits au même prix exact → `clarification_requise`
- Aucun produit en mémoire au prix mentionné → TYPE A2 (nouvelle recherche)

### Demandes de continuité (TYPE A3)

Détecter l'intention de continuité si le message exprime (quelle que soit la formulation) :

- voir davantage de produits du même type
- obtenir des alternatives à ce qui a déjà été montré
- poursuivre une recherche en cours

Exemples : "d'autre", "encore", "autre modèle", "t'as pas autre chose ?", "montre-moi plus"

**Règle si continuité détectée :**

- Réutiliser `derniere_requete_produit` TELLE QUELLE
- NE PAS utiliser le message client comme nouvelle requête
- Exclure les `produits_deja_envoyes` (filtrage post-traitement sur les résultats retournés)
- `nouvelle_limite = min(derniere_limite_recherche + 5, 20)`

---

## Étape 3 — Checkpoint avant Search Supabase

**Vérifier dans l'ordre AVANT tout appel Supabase :**

```
□ Produit identifiable depuis produit_actif ?
□ Produit identifiable depuis produits_recents (attributs + catégorie cohérents) ?
□ derniere_requete_produit couvre la demande actuelle ?
```

→ Au moins une case cochée : **NE PAS appeler Supabase**, résoudre depuis la mémoire
→ Aucune case cochée : **lancer la recherche Supabase**

### Règle de court-circuit — réutilisation du résultat précédent

Avant tout appel Supabase, comparer la nouvelle demande avec `derniere_requete_produit` selon l'arbre de décision suivant :

#### Cas 1 — Même produit, mêmes caractéristiques (orthographe / formulation différente)

> Ex : `derniere_requete_produit = "tshirt"` → nouvelle demande = "t shirt" ou "t-shirt"

**→ Retourner directement le résultat précédent** (`dernier_resultat_recherche`), quel que soit son statut (`produit_trouve`, `aucun_produit`, `produit_multiple`). Ne pas vectoriser, ne pas appeler Supabase.

#### Cas 2 — Même produit, attribut nouveau ou différent

> Ex : `derniere_requete_produit = "tshirt"` → nouvelle demande = "t-shirt rouge"
> Ex : `derniere_requete_produit = "sandales pointure 22"` → nouvelle demande = "sandales pointure 24"

1. Filtrer `dernier_resultat_recherche.produits` sur le nouvel attribut (couleur, taille, pointure, etc.)
2. **Si au moins un produit correspond après filtrage** → retourner les produits filtrés, statut `produit_trouve` ou `produit_multiple` selon le nombre. Ne pas appeler Supabase.
3. **Si aucun produit ne correspond après filtrage** → lancer une nouvelle recherche Supabase avec la requête combinée (catégorie + nouvel attribut, ex : "t-shirt rouge").

#### Cas 3 — Produit différent

> Ex : `derniere_requete_produit = "tshirt"` → nouvelle demande = "pantalon"

**→ Lancer la recherche Supabase** normalement. Aucune réutilisation possible.

---

## Étape 4 — Recherche Supabase

### Paramètres par défaut

```
match_count_defaut  = 5
match_count_max     = 20
match_threshold     = 0.2
```

### CAS TEXTE (TYPE A2, A3) — Procédure en 2 étapes

#### Étape 4a — Vectoriser la requête via MCP `embedding-server`

```json
{
  "text": "<requête extraite du message client>",
  "model": "text-embedding-3-small"
}
```

Récupérer le vecteur retourné (tableau de floats).

#### Étape 4b — Appeler `match_images` via POST REST (Bash + curl)

1. Récupérer les credentials via MCP :
   - `mcp__supabase__get_project_url` → `$SUPABASE_URL`
   - `mcp__supabase__get_publishable_keys` → prendre la clé `anon` (legacy) → `$ANON_KEY`

2. Écrire le payload dans un fichier temporaire (évite les problèmes de taille inline) :

```bash
python3 -c "
import json
payload = {
    'query_embedding': [/* vecteur étape 4a */],
    'match_threshold': 0.2,
    'match_count': 5
}
with open('/tmp/match_payload.json', 'w') as f:
    json.dump(payload, f)
"
```

3. Exécuter le POST via curl :

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/match_images" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/match_payload.json
```

> Note : `produits_deja_envoyes` n'est pas un paramètre RPC — appliquer ce filtre
> en post-traitement sur les résultats retournés par `match_images`.

### CAS IMAGE (TYPE C) — Procédure en 2 étapes

#### Étape 4a-image — Décrire l'image reçue

Analyser l'image envoyée par le client et générer une description textuelle concise :
couleur, type de vêtement/produit, motif, matière visible, etc.

Stocker cette description dans `description_image`.

#### Étape 4b-image — Vectoriser la description puis appeler `match_images`

Utiliser `description_image` comme texte d'entrée pour `mcp__embedding-server__embed_text`,
puis appeler `match_images` avec le vecteur obtenu (même procédure que le cas texte).

> Si `match_images` retourne un tableau vide → statut `aucun_produit`.
> Ne pas tenter d'autres appels SQL ou RPC alternatifs.

---

## Étape 5 — Validation renforcée des résultats

1. Extraire les mots-clés significatifs de la requête (ignorer : "prix", "combien", "avez-vous", "je veux", "montre", "cherche")
2. Vérifier que les mots-clés apparaissent dans : titre / description / catégorie / attributs du produit
3. Aucun produit ne correspond aux mots-clés → `aucun_produit`
4. Score élevé sans cohérence métier → **rejeter**
5. En cas de doute → `aucun_produit` ou `clarification_requise` plutôt que faux positif

---

## Étape 6 — Construction du payload

### TYPE A1 / A2 — Résultat recherche produit

```json
{
  "type": "resultat_recherche",
  "status": "produit_trouve | produit_multiple | aucun_produit | clarification_requise",
  "produit_reference": {
    "id": "...",
    "nom": "...",
    "source_resolution": "memoire | historique | recherche | null"
  },
  "produits": [
    {
      "id": "string",
      "description": "string",
      "upload_id": "string",
      "similarity": 0.0
    }
  ],
  "attributs_detectes": {
    "couleur": "...",
    "taille": "...",
    "pointure": "...",
    "prix": "...",
    "quantite": "..."
  },
  "intention_achat": "non",
  "message_client_original": "...",
  "raison_clarification": "..."
}
```

### TYPE A3 — Continuité / variantes

Même structure que TYPE A1/A2, avec en plus :

```json
{
  "type": "resultat_recherche",
  "continuite": true,
  "requete_reutilisee": "<valeur de derniere_requete_produit>",
  "...": "..."
}
```

### TYPE A4 — Intention d'achat

```json
{
  "type": "resultat_recherche",
  "status": "produit_trouve | clarification_requise",
  "intention_achat": "oui",
  "produit_reference": {
    "id": "...",
    "nom": "...",
    "source_resolution": "memoire | historique | recherche | null"
  },
  "attributs_detectes": {
    "couleur": "...",
    "taille": "...",
    "pointure": "...",
    "quantite": "..."
  },
  "message_client_original": "..."
}
```

### TYPE B — Demande générale

```json
{
  "type": "demande_generale",
  "message_client_original": "...",
  "contexte_produit_actif": {
    "id": "...",
    "nom": "..."
  }
}
```

### TYPE C — Image

```json
{
  "type": "resultat_recherche_image",
  "status": "produit_trouve | produit_multiple | aucun_produit | clarification_requise",
  "description_image": "...",
  "produits": [
    {
      "id": "string",
      "description": "string",
      "upload_id": "string",
      "similarity": 0.0
    }
  ],
  "intention_achat": "oui | non",
  "message_client_original": "..."
}
```

### TYPE D — Ambigu

```json
{
  "type": "clarification",
  "message_client_original": "...",
  "raison": "...",
  "contexte_candidats": []
}
```

---

## Étape 7 — Mise à jour mémoire

- Produits proposés au client → ajouter dans `produits_recents` + `produits_deja_envoyes`
- Produit confirmé par client → mettre à jour `produit_actif` (selon cycle de vie)
- Nouvelle requête explicite → mettre à jour `derniere_requete_produit`
- Valeur `match_count` utilisée → mettre à jour `derniere_limite_recherche`
- Résultat de chaque appel Supabase → mettre à jour `dernier_statut_recherche` + `dernier_resultat_recherche` (liste brute complète)

---

## Règle absolue de sortie

Après transmission au module Assistant Make/n8n :

- Retourner **EXACTEMENT** le JSON brut renvoyé par ce module
- Sans modification, sans reformulation, sans texte avant/après
- Sans générer son propre JSON final

---

## Interdictions absolues

- Ne jamais répondre directement au client
- Ne jamais inventer un produit ou une information
- Ne jamais choisir arbitrairement entre plusieurs produits plausibles
- Ne jamais se fier uniquement au score de similarité Supabase
- Ne jamais perdre le contexte produit si la conversation dévie
- Ne jamais appeler Supabase sans avoir passé le checkpoint
- Ne jamais modifier la réponse brute du module Assistant
- **Ne jamais utiliser `execute_sql` ou toute requête SQL directe — toujours faire un POST curl à `/rest/v1/rpc/match_images`**
- **Toujours écrire le payload JSON dans un fichier `/tmp/match_payload.json` avant le curl (jamais inline)**

---

## Références complémentaires

- `references/supabase-search.md` — Requêtes Supabase types (vectorielle + textuelle)
- `references/prompt-orchestrateur.md` — Prompt système complet prêt à l'emploi dans Make/n8n
