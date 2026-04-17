# Supabase — Requêtes de recherche produits

## Configuration MCP

```json
{
  "supabase": {
    "type": "http",
    "url": "https://mcp.supabase.com/mcp?project_ref=ymdngagxbpjqanczloyv"
  }
}
```

---

### Étape 1 — Vectoriser via MCP `embedding-server`

```json
// Outil : mcp__embedding-server__embed_text
{
  "text": "<requête client>",
  "model": "text-embedding-3-small"
}
```

Récupérer le tableau de floats retourné.

### Étape 2 — Récupérer les credentials Supabase

```
mcp__supabase__get_project_url      → SUPABASE_URL
mcp__supabase__get_publishable_keys → ANON_KEY  (prendre la clé type "legacy" / "anon")
```

### Étape 3 — Écrire le payload dans un fichier temporaire

```bash
python3 -c "
import json
payload = {
    'query_embedding': [/* vecteur étape 1, 1536 floats */],
    'match_threshold': 0.2,
    'match_count': 5
}
with open('/tmp/match_payload.json', 'w') as f:
    json.dump(payload, f)
"
```

> Toujours passer par un fichier — ne jamais inliner le vecteur dans la commande curl.

### Étape 4 — POST `/rest/v1/rpc/match_images` via curl

```bash
curl -s -X POST "https://<project_ref>.supabase.co/rest/v1/rpc/match_images" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d @/tmp/match_payload.json
```

> Si le tableau retourné est vide → statut `aucun_produit`. Ne pas exécuter d'autres requêtes.

## Mapping résultat → payload orchestrateur

```javascript
// Transformer les résultats Supabase en format payload
const produits = supabaseResults.map((row) => ({
  id: row.id,
  description:
    `${row.nom} - ${row.couleur || ""} ${row.taille || ""} - ${row.prix} Ar`.trim(),
  upload_id: row.upload_id,
  similarity: row.similarity || null,
}));
```

---

## Gestion des erreurs courantes

| Erreur                                 | Cause probable               | Solution                                                             |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `function match_images does not exist` | Fonction RPC non créée       | Utiliser l'Option 2 (textuelle) ou créer la fonction                 |
| `column embedding does not exist`      | Colonne vector manquante     | Activer l'extension pgvector et ajouter la colonne                   |
| `0 résultats` avec threshold 0.2       | Requête trop spécifique      | Baisser le threshold à 0.15 ou utiliser recherche textuelle          |
| Résultats hors sujet                   | Score similarity insuffisant | Appliquer la validation renforcée, rejeter les résultats incohérents |
