// Cree un Checkout HelloAsso pour un dossier periscolaire, a partir du JETON du lien.
// Montant LU cote serveur (montant_du_cents verrouille) -> jamais depuis le navigateur.
// ⚠️ DEPLOIEMENT : verify_jwt=false OBLIGATOIRE (l'auth = le jeton ; payer.html n'envoie
//    pas d'Authorization) -> `supabase functions deploy helloasso-creer-paiement --no-verify-jwt`.
//
// v4  (30/06/2026) : plafond anti-faute-de-frappe (#15 de l'audit).
// v5  (30/07/2026) : cloison d'argent fail-closed + libelle tire de l'association reelle.
// v9  (10/08/2026) : ETEINTE (stub 503) — etape 0 du Coup 3, decision GB.
// v10 (30/08/2026) : RALLUMAGE + RE-CLE sur le DOSSIER (migration 62) — jeton lu sur
//   `dossiers`, paiement ecrit avec dossier_id ET inscription_periscolaire_id, drapeau
//   f_paiement_ligne lu cote serveur (fail-closed).
// v11 (30/08/2026, apres relecture adverse) :
//   - CHAQUE retour supabase-js est LU (data ET error) : plus aucun garde fail-open
//     sur erreur de requete, plus aucune ecriture au resultat ignore ;
//   - deja_paye = SOMME NETTE des 'paye' comparee au du (miroir de peri_paiement_public
//     v88) ; un acompte au comptoir rend 'acompte_au_comptoir' (pas « deja paye ») ;
//   - verrou du canal en ligne verifie AVANT le checkout (miroir de l'index
//     paiements_online_paid_per_* : un paiement en ligne rembourse bloque le canal —
//     sinon la famille paierait un checkout que le webhook ne pourrait jamais solder) ;
//   - la reutilisation d'un checkout chaud exige le MEME montant (un montant re-valide
//     par le bureau expirait l'ancienne intention… sans ce garde, la famille payait
//     l'ancien prix) ;
//   - drapeau accepte true / 'on' / 'true' (contrat de asso_has_feature) ;
//   - une ligne en_attente dont le checkout echoue est passee en 'erreur' (plus
//     d'orphelines qui s'empilent), metadata fusionnee (source conservee).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HA_API = "https://api.helloasso.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PLAFOND_CENTS = 200000; // 2000 € : au-dela = quasi surement une erreur de saisie -> on refuse

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function haToken(cfg: any): Promise<string> {
  const r = await fetch(`${HA_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret }),
  });
  if (!r.ok) throw new Error(`oauth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_non_autorisee" }, 405);
  try {
    const b = await req.json().catch(() => ({} as any));
    const token = String(b.pay_token ?? "").trim();
    if (token.length < 20) return json({ error: "token_absent" }, 400);
    const retour = (typeof b.retour_url === "string" && b.retour_url.startsWith("https://")) ? b.retour_url : "https://casebdn.re";
    const sep = retour.includes("?") ? "&" : "?";

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // RE-CLE (migration 62) : le jeton vit sur le DOSSIER, et nulle part ailleurs.
    const { data: dos, error: edos } = await admin.from("dossiers")
      .select("id, asso_id, saison, montant_du_cents, legacy_key")
      .eq("pay_token", token).eq("type", "periscolaire").maybeSingle();
    if (edos) return json({ error: "verification_impossible" }, 500);
    if (!dos || !dos.montant_du_cents || dos.montant_du_cents < 100)
      return json({ error: "lien_invalide" }, 404);
    if (dos.montant_du_cents > PLAFOND_CENTS)  // #15 garde-fou : montant aberrant -> refus
      return json({ error: "montant_trop_eleve" }, 422);

    // DRAPEAU LU COTE SERVEUR (fail-closed). Contrat identique a asso_has_feature :
    // true (booleen) OU 'on'/'true' (texte, convention des autres modules).
    const { data: assoRow, error: easso } = await admin.from("associations")
      .select("name, features").eq("id", dos.asso_id).maybeSingle();
    if (easso) return json({ error: "verification_impossible" }, 500);
    const flag = assoRow?.features?.f_paiement_ligne;
    if (!(flag === true || flag === "on" || flag === "true")) {
      return json({
        error: "paiement_en_ligne_suspendu",
        message: "Le paiement en ligne du periscolaire est suspendu pour le moment. Merci de regler au comptoir, ou de contacter le bureau.",
      }, 503);
    }

    // Cle legacy (classeur), UUID STRICT — un legacy_key repare a la main ne doit
    // jamais faire echouer la verification anti-double en silence.
    const m = String(dos.legacy_key ?? "").match(/^peri-dossier:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const inscId = m ? m[1] : null;
    let userId: string | null = null;
    if (inscId) {
      const { data: insc, error: einsc } = await admin.from("inscriptions_periscolaire")
        .select("user_id").eq("id", inscId).maybeSingle();
      if (einsc) return json({ error: "verification_impossible" }, 500);
      userId = insc?.user_id ?? null;
    }

    // Gardes d'argent — FAIL-CLOSED : si la lecture echoue, on refuse.
    const orKeys = inscId
      ? `dossier_id.eq.${dos.id},inscription_periscolaire_id.eq.${inscId}`
      : `dossier_id.eq.${dos.id}`;
    const { data: payes, error: epay } = await admin.from("paiements")
      .select("id, montant_cents, annule_paiement_id, ha_checkout_intent_id")
      .eq("statut", "paye").or(orKeys);
    if (epay) return json({ error: "verification_impossible" }, 500);
    const rows = payes ?? [];
    // Somme NETTE (les contre-ecritures negatives se deduisent toutes seules) —
    // miroir exact du deja_paye de peri_paiement_public (migration 88).
    const verse = rows.reduce((s: number, p: any) => s + (Number(p.montant_cents) || 0), 0);
    if (verse >= dos.montant_du_cents) return json({ error: "deja_paye" }, 409);
    // Verrou du canal EN LIGNE, miroir de l'index paiements_online_paid_per_* :
    // un paiement en ligne rembourse occupe toujours l'index — creer un nouveau
    // checkout donnerait un paiement que le webhook ne pourrait JAMAIS solder.
    if (rows.some((p: any) => p.ha_checkout_intent_id && !p.annule_paiement_id)) {
      return json({
        error: "canal_en_ligne_verrouille",
        message: "Un paiement en ligne a deja eu lieu sur ce dossier. Merci de regler au comptoir, ou de contacter le bureau.",
      }, 409);
    }
    if (verse > 0) {
      return json({
        error: "acompte_au_comptoir",
        message: "Un reglement partiel est deja enregistre sur ce dossier : le solde se regle au comptoir, ou contactez le bureau.",
        deja_verse_cents: verse,
      }, 409);
    }

    // Reutilisation d'un checkout encore chaud (14 min) — MEME montant exige :
    // si le bureau a re-valide le montant entre-temps, l'ancienne intention est
    // perimee (on la passe en 'expire', au mieux) et on en cree une neuve.
    const since = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    const { data: recent, error: erec } = await admin.from("paiements")
      .select("id, ha_redirect_url, montant_cents").eq("dossier_id", dos.id)
      .eq("statut", "en_attente").not("ha_redirect_url", "is", null)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
    // Fail-closed aussi ICI (2e passe adverse) : sauter la reutilisation sur une
    // erreur de lecture creerait un 2e panier payable en parallele du premier.
    if (erec) return json({ error: "verification_impossible" }, 500);
    if (recent?.ha_redirect_url) {
      if (recent.montant_cents === dos.montant_du_cents) {
        return json({ redirectUrl: recent.ha_redirect_url, montant_cents: recent.montant_cents, reuse: true });
      }
      const { error: eexp } = await admin.from("paiements")
        .update({ statut: "expire" }).eq("id", recent.id).eq("statut", "en_attente");
      if (eexp) return json({ error: "verification_impossible" }, 500);
    }

    // 30/07/2026 -- CLOISON D'ARGENT (fail-closed). La configuration HelloAsso est GLOBALE :
    // un seul compte, celui de l'association declaree dans HELLOASSO_ASSO_ID. Sans ce controle,
    // le paiement d'une AUTRE association partirait sur ce compte-la = encaissement pour le
    // compte d'autrui. On refuse plutot que de deviner. Verification AVANT d'ecrire la ligne de
    // paiement, pour ne pas laisser de ligne "en_attente" orpheline.
    const cfg = (await admin.rpc("helloasso_config")).data as any;
    if (!cfg?.client_id) return json({ error: "config_absente" }, 500);
    if (!cfg?.asso_id) return json({ error: "config_sans_asso" }, 500);
    if (dos.asso_id !== cfg.asso_id)
      return json({ error: "paiement_non_configure_pour_cette_asso" }, 403);

    const montant_cents = dos.montant_du_cents;
    // Libelle tire de l'association reelle (accents retires : le reste du fichier est sans accent).
    const nomAsso = String(assoRow?.name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim() || "association";
    const libelle = `Periscolaire ${dos.saison} - ${nomAsso}`;

    const { data: pay, error: perr } = await admin.from("paiements").insert({
      asso_id: dos.asso_id, user_id: userId,
      inscription_periscolaire_id: inscId, dossier_id: dos.id,
      objet: "periscolaire", libelle, montant_cents, statut: "en_attente", metadata: { source: "lien" },
    }).select("id").single();
    if (perr || !pay) return json({ error: "creation_paiement", detail: perr?.message }, 500);

    // A partir d'ici, toute sortie en echec DOIT marquer la ligne 'erreur' :
    // une en_attente muette (sans redirect) est invisible a la reutilisation et
    // s'empilerait a chaque re-clic pendant un incident HelloAsso.
    let ci: any = null, ciOk = false;
    try {
      const tok = await haToken(cfg);
      const r = await fetch(`${HA_API}/v5/organizations/${cfg.org_slug}/checkout-intents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "User-Agent": UA, "Accept": "application/json" },
        body: JSON.stringify({
          totalAmount: montant_cents, initialAmount: montant_cents, itemName: libelle,
          backUrl: `${retour}${sep}paiement=annule`, errorUrl: `${retour}${sep}paiement=erreur`,
          returnUrl: `${retour}${sep}paiement=ok&pid=${pay.id}`, containsDonation: false,
          metadata: { paiement_id: pay.id, asso_id: dos.asso_id, objet: "periscolaire" },
        }),
      });
      ci = await r.json().catch(() => ({} as any));
      ciOk = r.ok && !!ci.redirectUrl;
    } catch (e) {
      ci = { exception: String(e) };
      ciOk = false;
    }
    if (!ciOk) {
      await admin.from("paiements").update({ statut: "erreur", metadata: { source: "lien", error: ci } }).eq("id", pay.id);
      return json({ error: "helloasso_checkout", detail: ci }, 502);
    }
    const { error: eup } = await admin.from("paiements")
      .update({ ha_checkout_intent_id: String(ci.id), ha_redirect_url: ci.redirectUrl }).eq("id", pay.id);
    if (eup) {
      // Sans l'intent enregistre, le webhook ne saurait pas confirmer : on ne
      // laisse PAS la famille partir payer un checkout intracable.
      await admin.from("paiements").update({ statut: "erreur", metadata: { source: "lien", error: { update: eup.message } } }).eq("id", pay.id);
      return json({ error: "enregistrement_checkout", detail: eup.message }, 502);
    }
    return json({ paiement_id: pay.id, redirectUrl: ci.redirectUrl, montant_cents });
  } catch (e) {
    return json({ error: "exception", detail: String(e) }, 500);
  }
});
