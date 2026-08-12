// helloasso-reverifier — REJOUE la vérification des paiements restés « en_attente ».
//
// POURQUOI ELLE EXISTE (13/08/2026). Le webhook HelloAsso est le SEUL chemin par
// lequel un paiement devient « payé ». S'il ne passe pas — notification perdue,
// jeton refusé, panne réseau, ou simplement famille qui a abandonné — le paiement
// reste « en_attente » POUR TOUJOURS, et rien ne le signale. Mesuré ce jour :
// 5 adhésions bloquées depuis 19 à 36 jours, toutes parties chez HelloAsso.
// Impossible de savoir, depuis Bob, si la famille a renoncé ou si la confirmation
// s'est perdue. Cette fonction pose la question à HelloAsso et rend la réponse.
//
// 🔴 CE QU'ELLE NE PEUT PAS FAIRE, PAR CONSTRUCTION :
//   · elle ne marque JAMAIS un paiement « payé » sans que HelloAsso l'ait confirmé
//     (même logique exacte que le webhook : un paiement Authorized/Registered) ;
//   · elle ne DÉ-marque jamais un paiement déjà payé ;
//   · elle n'invente aucun statut : une famille qui n'a pas payé reste « en_attente »
//     et ressort dans la liste « à relancer ». Décider de son sort est un geste
//     humain, pas un geste de code.
//
// 🔒 MODE PAR DÉFAUT = SIMULATION. Sans `{"appliquer": true}` dans le corps, elle
// LIT et RAPPORTE sans rien écrire. On regarde d'abord, on écrit ensuite.
//
// 🔑 RÉSERVÉE AU BUREAU : verify_jwt = true, plus un contrôle de rôle
// (president / tresorier / bureau) ET la cloison d'argent — l'appelant doit
// appartenir à l'association réellement configurée chez HelloAsso.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HA_API = "https://api.helloasso.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function haToken(cfg: any): Promise<string> {
  const r = await fetch(`${HA_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret }),
  });
  if (!r.ok) throw new Error(`oauth ${r.status}`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_non_autorisee" }, 405);

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1) Qui appelle ? On ne fait jamais confiance au corps pour l'identité.
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "non_connecte" }, 401);
    const { data: uData } = await admin.auth.getUser(jwt);
    const uid = uData?.user?.id;
    if (!uid) return json({ error: "non_connecte" }, 401);

    const { data: prof } = await admin.from("profiles").select("asso_id, role, statut").eq("id", uid).maybeSingle();
    if (!prof?.asso_id) return json({ error: "profil_absent" }, 403);
    if (prof.statut !== "actif") return json({ error: "compte_non_actif" }, 403);
    if (!["president", "tresorier", "bureau"].includes(String(prof.role)))
      return json({ error: "reserve_au_bureau" }, 403);

    // 2) Cloison d'argent, fail-closed : la configuration HelloAsso est GLOBALE.
    //    Sans ce contrôle, le bureau d'une autre association interrogerait — et
    //    régulariserait — les paiements encaissés sur le compte du CASE.
    const cfg = (await admin.rpc("helloasso_config")).data as any;
    if (!cfg?.client_id) return json({ error: "config_absente" }, 500);
    if (!cfg?.asso_id) return json({ error: "config_sans_asso" }, 500);
    if (prof.asso_id !== cfg.asso_id)
      return json({ error: "paiement_non_configure_pour_cette_asso" }, 403);

    const body = await req.json().catch(() => ({} as any));
    const appliquer = body?.appliquer === true;          // 🔒 simulation par défaut
    const joursMin = Number.isFinite(body?.jours_min) ? Number(body.jours_min) : 0;

    // 3) Les paiements à re-questionner : en attente, partis chez HelloAsso.
    const seuil = new Date(Date.now() - joursMin * 86400000).toISOString();
    const { data: enAttente, error: qerr } = await admin.from("paiements")
      .select("id, objet, libelle, montant_cents, created_at, ha_checkout_intent_id, metadata")
      .eq("asso_id", cfg.asso_id)
      .eq("statut", "en_attente")
      .not("ha_checkout_intent_id", "is", null)
      .lte("created_at", seuil)
      .order("created_at", { ascending: true });
    if (qerr) return json({ error: "lecture_paiements", detail: qerr.message }, 500);

    const lignes: any[] = [];
    let regularises = 0, ecarts = 0, toujoursImpayes = 0, illisibles = 0;

    const tok = await haToken(cfg);

    for (const pay of (enAttente ?? [])) {
      const jours = Math.floor((Date.now() - new Date(pay.created_at).getTime()) / 86400000);
      const base = { paiement_id: pay.id, objet: pay.objet, montant_du_cents: pay.montant_cents, jours };

      let ci: any = null;
      try {
        const r = await fetch(`${HA_API}/v5/organizations/${cfg.org_slug}/checkout-intents/${pay.ha_checkout_intent_id}`, {
          headers: { Authorization: `Bearer ${tok}`, "User-Agent": UA, "Accept": "application/json" },
        });
        if (r.ok) ci = await r.json();
      } catch (_) { /* ci reste null */ }

      if (!ci) {
        illisibles++;
        lignes.push({ ...base, verdict: "illisible", explication: "HelloAsso n'a pas répondu pour ce panier — à rejouer plus tard." });
        continue;
      }

      // Même lecture que le webhook : un paiement Authorized ou Registered vaut confirmation.
      const order = ci?.order;
      const pmts = order?.payments;
      const ok = Array.isArray(pmts) ? pmts.find((p: any) => ["Authorized", "Registered"].includes(p.state)) : null;

      if (!ok) {
        toujoursImpayes++;
        // ⚠️ Les textes `explication` sont AFFICHÉS au bureau dans Bob : ils portent
        //    leurs accents et parlent en euros, pas en centimes. Le reste du fichier
        //    reste sans accent (convention des fonctions HelloAsso).
        lignes.push({ ...base, verdict: "jamais_paye", explication: "HelloAsso ne connaît aucun paiement abouti : la famille n'est pas allée au bout. À relancer — on ne touche à rien." });
        continue;
      }

      const paidTotal = (order?.amount?.total != null)
        ? Number(order.amount.total)
        : pmts.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
      const expected = Number(pay.montant_cents);
      const amountOk = paidTotal != null && Math.abs(paidTotal - expected) < 1;
      const nouveauStatut = amountOk ? "paye" : "a_verifier";
      if (amountOk) regularises++; else ecarts++;

      lignes.push({
        ...base,
        verdict: amountOk ? "PAYE_non_enregistre" : "ecart_de_montant",
        encaisse_cents: paidTotal,
        explication: amountOk
          ? "La famille a bien payé : la confirmation ne nous est jamais revenue. À régulariser."
          : `Somme encaissée (${(paidTotal / 100).toFixed(2).replace(".", ",")} €) différente du montant dû (${(expected / 100).toFixed(2).replace(".", ",")} €) — à examiner à la main.`,
        applique: appliquer,
      });

      if (appliquer) {
        // Le passage a "paye" declenche trg_paiement_ouvre_adhesion (migration 63) :
        // l'adherent est cree dans la foulee, sans geste supplementaire.
        await admin.from("paiements").update({
          statut: nouveauStatut,
          paid_at: new Date().toISOString(),
          ha_order_id: order?.id ? String(order.id) : null,
          ha_payment_id: ok?.id ? String(ok.id) : null,
          metadata: {
            ...(pay.metadata || {}),
            verif: { paid_total_cents: paidTotal, expected_cents: expected, match: amountOk },
            reverifie_le: new Date().toISOString(),
            reverifie_par: "helloasso-reverifier",
          },
        }).eq("id", pay.id);
      }
    }

    return json({
      mode: appliquer ? "APPLIQUE" : "SIMULATION (rien n'a ete ecrit)",
      examines: lignes.length,
      resume: {
        payes_non_enregistres: regularises,
        ecarts_de_montant: ecarts,
        jamais_payes_a_relancer: toujoursImpayes,
        illisibles: illisibles,
      },
      lignes,
    });
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});
