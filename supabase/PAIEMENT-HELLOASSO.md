# Paiement en ligne périscolaire — HelloAsso ↔ Bob (CASE du Bois de Nèfles)

Sauvegarde / documentation du système de paiement. Projet Supabase : **bob-asso** (`dkidtwypclpwznleiqnq`, région Paris).

## Vue d'ensemble du flux

1. **Bureau** (app.html, fonction `loadDossiersPeri` → bloc « Paiement en ligne ») saisit `€/jour × nb jours` → appelle la RPC `peri_valider_montant` (SECURITY DEFINER) qui **verrouille** le montant sur `inscriptions_periscolaire` (`montant_du_cents`, `tarif_detail`) et génère un `pay_token`.
2. Le bureau copie le **lien** `payer.html?t=<pay_token>` et l'envoie à la famille.
3. **Famille** ouvre `payer.html` (sans login) → la page lit le montant via la RPC publique `peri_paiement_public(token)` → bouton « Payer » → appelle l'Edge Function **`helloasso-creer-paiement`**.
4. `helloasso-creer-paiement` (service_role) **relit le montant côté serveur** (jamais depuis le navigateur), crée un *checkout-intent* HelloAsso, renvoie l'URL de paiement.
5. Famille paie sur HelloAsso → l'argent va **directement sur le compte BNP du CASE**.
6. HelloAsso appelle le webhook **`helloasso-webhook`** (gate `?token=`) qui **re-vérifie** le paiement chez HelloAsso, **compare le montant encaissé au montant dû**, puis passe la ligne `paiements` en `paye` (ou `a_verifier` si le montant ne colle pas).

## Edge Functions (déployées, `verify_jwt=false` — l'auth = le jeton)

- `helloasso-creer-paiement` — voir `functions/helloasso-creer-paiement/index.ts`
- `helloasso-webhook` — voir `functions/helloasso-webhook/index.ts`

Redéploiement : via le MCP Supabase (`deploy_edge_function`) ou la CLI `supabase functions deploy <slug>`.

## Secrets (jamais en façade)

Stockés dans le **Vault** Supabase, lus côté serveur par la RPC `helloasso_config()` (service_role only) :
`client_id`, `client_secret`, `org_slug` (`case-du-bois-de-nefles`), `webhook_token`.

## Base de données (public)

- Table **`paiements`** : RLS = lecture famille (ses paiements) + bureau ; **aucune** écriture par `authenticated` (seuls le service_role et les RPC SECURITY DEFINER écrivent).
- Colonnes ajoutées à `inscriptions_periscolaire` : `montant_du_cents`, `tarif_detail` (jsonb), `pay_token`, `montant_valide_at`, `montant_valide_by`.
- **Sécurité (correctif audit #1, 30/06/2026)** : `REVOKE UPDATE` table-level sur `inscriptions_periscolaire` (authenticated+anon) puis `GRANT UPDATE` sur **toutes les colonnes SAUF** les colonnes financières + `id`. → une famille ne peut PAS modifier le montant/jeton de sa propre inscription.
- **Anti double-paiement (audit #3)** : index unique partiel `paiements(inscription_periscolaire_id) WHERE statut='paye'`.
- RPC : `peri_valider_montant(uuid, int, jsonb)` [bureau], `peri_paiement_public(text)` [public/anon, lecture par jeton], `helloasso_config()` [service_role].

## Reste à faire (cf. audit 30/06/2026, fiche mémoire case-paiement-en-ligne)

🔴 Vote du règlement périscolaire au CA (opposabilité du forfait) + case d'acceptation famille + l'afficher sur payer.html.
🟠 Écriture auto de la recette en compta (`ops`/`op_splits`) · rattrapage si webhook manqué · espace famille self-service.
🟡 Remboursement · avertissement pourboire HelloAsso · enfant+mois sur payer.html.
