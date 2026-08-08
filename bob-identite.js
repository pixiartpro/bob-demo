/* ============================================================================
   BOB · IDENTITÉ DE TENANT — l'habillage d'une association vient de SES DONNÉES
   ----------------------------------------------------------------------------
   07/08/2026. Brique produit, pas brique client.

   LE PROBLÈME QU'ELLE FERME
   Jusqu'ici l'habillage d'une asso vivait dans DEUX tableaux écrits en dur :
     · app.html            → ASSO_IDENTITY, indexé par UUID d'association
     · espace-projets.html → DOORS{}, indexé par slug ('bokaf', 'case-bdn'…)
   Conséquence : la 4e association ne pouvait PAS avoir son identité sans qu'on
   rouvre deux fichiers. C'est une dette de multi-tenance — indolore à 3 assos,
   c'est le mur à la 20e.

   LE TEST QUI TRANCHE : « le 4e client peut-il arriver sans qu'on touche au
   code ? » Ici la réponse est oui — son identité est une DONNÉE qu'il pose.

   ⚠️ PIÈGE RÉEL, mesuré le 07/08/2026 (RLS de bob-asso) :
   la table `fiches_marque` (couleurs + logo de la charte) est lisible par
   `is_staff()` UNIQUEMENT. Un ADHÉRENT ne peut donc pas la lire : un habillage
   fondé sur elle marche dans la gestion et échoue en silence côté membre —
   le bureau et l'adhérent verraient deux applications différentes.
   → La source de vérité de l'habillage est `associations.features.identite`,
     que tout membre actif de l'asso peut lire (policy `sel_asso`).
     `fiches_marque` reste un COMPLÉMENT, lu quand on y a droit.

   ORDRE DE RÉSOLUTION (le premier qui répond gagne, champ par champ)
     1. associations.features.identite   ← la voie produit
     2. fiches_marque (si lisible)       ← la charte déjà remplie par l'asso
     3. AMORCE (ci-dessous)              ← graine de migration, transitoire
     4. défaut neutre                    ← une asso sans rien reste présentable

   RÉVERSIBLE : ne rien trouver n'est pas une panne. Sans aucune donnée, on rend
   le défaut neutre et l'application reste utilisable.
   ============================================================================ */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
     1. COULEUR — mesurer avant d'affirmer
     Une asso déclare une couleur ; nous devons garantir que le texte posé
     dessus reste lisible. Tout ce qui suit est du calcul WCAG, pas du goût.
     --------------------------------------------------------------------------- */

  /** #abc / #aabbcc / aabbcc → [r,g,b] 0-255, ou null si ce n'est pas une couleur. */
  function versRgb(hex) {
    if (typeof hex !== 'string') return null;
    var v = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
    return [0, 2, 4].map(function (i) { return parseInt(v.substr(i, 2), 16); });
  }

  function versHex(rgb) {
    return '#' + rgb.map(function (n) {
      var x = Math.max(0, Math.min(255, Math.round(n)));
      return ('0' + x.toString(16)).slice(-2);
    }).join('');
  }

  /** Luminance relative WCAG 2.1. */
  function luminance(hex) {
    var rgb = versRgb(hex); if (!rgb) return 0;
    var c = rgb.map(function (n) {
      var x = n / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /** Rapport de contraste WCAG entre deux couleurs (1 → 21). */
  function contraste(a, b) {
    var x = luminance(a), y = luminance(b);
    var hi = Math.max(x, y), lo = Math.min(x, y);
    return (hi + 0.05) / (lo + 0.05);
  }

  function melanger(hex, vers, part) {
    var a = versRgb(hex), b = versRgb(vers);
    if (!a || !b) return hex;
    return versHex([0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * part; }));
  }

  var assombrir = function (hex, p) { return melanger(hex, '#000000', p); };
  var eclaircir = function (hex, p) { return melanger(hex, '#ffffff', p); };

  /** L'encre lisible SUR un fond donné : celle des deux qui contraste le mieux. */
  function encreSur(fond, clair, sombre) {
    clair = clair || '#ffffff'; sombre = sombre || '#0d0d12';
    return contraste(fond, clair) >= contraste(fond, sombre) ? clair : sombre;
  }

  /**
   * Le couple {remplissage, encre} d'un bouton plein, garanti lisible.
   *
   * Mesuré le 07/08/2026 : sur le rouge PIX-I-ART #E8300A, NI le blanc (4,48:1)
   * NI le quasi-noir n'atteignent AA. Se contenter du « moins pire » aurait posé
   * un libellé de bouton sous le seuil dans tout le produit. On garde donc la
   * TEINTE déclarée par l'asso et on ne bouge que sa clarté, jusqu'à ce que le
   * couple passe. La couleur déclarée reste intacte pour le texte et les filets
   * (--brand) ; seul le remplissage (--brand-fill) est dérivé.
   *
   * @returns {{fill:string, ink:string, ratio:number, ajuste:boolean}}
   */
  /** Distance RGB entre deux couleurs — sert à mesurer « combien on a déformé la marque ». */
  function ecart(a, b) {
    var x = versRgb(a), y = versRgb(b);
    if (!x || !y) return Infinity;
    return Math.sqrt(Math.pow(x[0] - y[0], 2) + Math.pow(x[1] - y[1], 2) + Math.pow(x[2] - y[2], 2));
  }

  function remplissageLisible(couleur, cible) {
    cible = cible || 4.5;
    var CLAIR = '#ffffff', SOMBRE = '#12101a';
    if (!versRgb(couleur)) return { fill: couleur, ink: CLAIR, ratio: 0, ajuste: false };

    /* On étudie les DEUX encres possibles. Pour chacune, on cherche le plus petit
       ajustement de clarté (la teinte ne bouge jamais) qui fait passer AA. Puis on
       retient l'option qui DÉFORME LE MOINS la couleur déclarée : c'est la marque de
       l'asso, pas la nôtre — on la respecte au plus près, on ne la « corrige » pas. */
    function candidat(ink) {
      if (contraste(ink, couleur) >= cible) return { fill: couleur, ink: ink, ratio: contraste(ink, couleur), cout: 0 };
      var versSombre = luminance(ink) > 0.5;   // encre claire → on assombrit le fond
      for (var i = 1; i <= 24; i++) {
        var essai = versSombre ? assombrir(couleur, i * 0.03) : eclaircir(couleur, i * 0.03);
        var r = contraste(ink, essai);
        if (r >= cible) return { fill: essai, ink: ink, ratio: r, cout: ecart(essai, couleur) };
      }
      return null;   // cette encre ne peut pas passer, même au bout de l'échelle
    }
    var a = candidat(CLAIR), b = candidat(SOMBRE);
    var choix = (!a) ? b : (!b) ? a : (a.cout <= b.cout ? a : b);
    if (!choix) {   // ne devrait pas arriver : le blanc finit toujours par passer sur du noir
      return { fill: couleur, ink: encreSur(couleur), ratio: contraste(encreSur(couleur), couleur), ajuste: false };
    }
    return { fill: choix.fill, ink: choix.ink, ratio: choix.ratio, ajuste: choix.cout > 0 };
  }

  /**
   * Remonte une couleur jusqu'à ce qu'elle contraste assez avec le fond.
   * Une asso a le droit de déclarer un bordeaux sombre ; posé sur un fond noir
   * il devient illisible. On garde SA teinte et on ne bouge que la clarté —
   * c'est toujours sa couleur, en version qui se lit.
   * @returns {{hex:string, ajuste:boolean, ratio:number}}
   */
  function lisibleSur(couleur, fond, cible) {
    cible = cible || 4.5;
    if (!versRgb(couleur) || !versRgb(fond)) return { hex: couleur, ajuste: false, ratio: 0 };
    var depart = contraste(couleur, fond);
    if (depart >= cible) return { hex: couleur, ajuste: false, ratio: depart };
    // Le fond est-il sombre ou clair ? On pousse la couleur dans l'autre sens.
    var versClair = luminance(fond) < 0.18;
    var essai = couleur, meilleur = couleur, meilleurRatio = depart;
    for (var i = 1; i <= 20; i++) {
      essai = versClair ? eclaircir(couleur, i * 0.045) : assombrir(couleur, i * 0.045);
      var r = contraste(essai, fond);
      if (r > meilleurRatio) { meilleurRatio = r; meilleur = essai; }
      if (r >= cible) return { hex: essai, ajuste: true, ratio: r };
    }
    return { hex: meilleur, ajuste: true, ratio: meilleurRatio };
  }

  /* ---------------------------------------------------------------------------
     2. LES DEUX MONDES
     Doctrine maison : cinéma sombre (média/studio/pro) OU chaleur claire
     (asso, grand public). Jamais les deux mélangés. Le monde n'est pas un
     détail de peinture : il décide du fond, de la typo, du rayon, du mouvement.
     --------------------------------------------------------------------------- */
  var MONDES = {
    cinema: {
      bg: '#0a0910', bg2: '#12111b', surface: '#17161f', surface2: '#1e1c29',
      /* ⚠️ `discret` et `tres_discret` sont mesurés contre `surface2`, le fond le
         PLUS CLAIR du monde : un gris qui passe sur le fond général peut tomber
         sous le seuil sur une carte survolée. Mesuré le 07/08/2026 — l'ancien
         #6f6c7d rendait 3,52:1 sur les cartes (AA exige 4,5). */
      encre: '#f5f4f8', discret: '#adaab9', tres_discret: '#908c9e',
      ligne: 'rgba(255,255,255,.085)', ligne_forte: 'rgba(255,255,255,.16)',
      ombre: '0 10px 30px -8px rgba(0,0,0,.55)',
      ombre_lg: '0 32px 80px -28px rgba(0,0,0,.72)',
      display: '"Sora", system-ui, sans-serif',
      corps: '"Inter", system-ui, sans-serif',
      ls_titre: '-.028em',
      radius: '18px', radius_pill: '100px', radius_champ: '12px',
      ease: 'cubic-bezier(.22,.61,.36,1)', duree: '.24s',
      /* Sémantiques : ces couleurs portent un SENS (adopté, en retard, alerte).
         Elles ne basculent JAMAIS en couleur de marque — on y perdrait le sens. */
      ok: '#3ecf8e', attention: '#f5a524', alerte: '#ff6b5e'
    },
    chaleur: {
      bg: '#f6f3ee', bg2: '#fffdfa', surface: '#ffffff', surface2: '#f2ede6',
      encre: '#2c2521', discret: '#6b5d54', tres_discret: '#7a6c62',
      ligne: 'rgba(60,50,46,.13)', ligne_forte: 'rgba(60,50,46,.24)',
      ombre: '0 8px 24px rgba(120,90,70,.10)',
      ombre_lg: '0 20px 54px rgba(120,90,70,.16)',
      display: '"Poppins", system-ui, sans-serif',
      corps: '"Inter", system-ui, sans-serif',
      ls_titre: '-.02em',
      radius: '18px', radius_pill: '100px', radius_champ: '12px',
      ease: 'cubic-bezier(.33,1,.68,1)', duree: '.2s',
      ok: '#1f8a5b', attention: '#b8730b', alerte: '#c53b26'
    }
  };

  /* ---------------------------------------------------------------------------
     3. LE DÉFAUT NEUTRE
     Une asso qui n'a rien déclaré doit rester présentable. Bleu Bob, monde
     chaleur : le produit, pas un client.
     --------------------------------------------------------------------------- */
  var DEFAUT = {
    nom: 'Mon association',
    embleme: '🤖',
    monde: 'chaleur',
    accent: '#3a51e8',
    accent_2: '#ffb02e',
    tagline: '',
    logo: '',
    site: '',
    mots: {}
  };

  /* ---------------------------------------------------------------------------
     4. AMORCE — GRAINE DE MIGRATION (transitoire, à faire disparaître)
     Ce bloc n'est PAS le mécanisme : c'est le contenu des anciens tableaux en
     dur, posé ici en attendant qu'il parte en base (voir
     `_interne/migration-identite-tenant.sql`). Les données de la base PRIMENT
     toujours sur cette amorce. Le jour où la migration est passée, ce bloc se
     supprime sans rien casser — et plus aucun nom de client ne vit dans le code.
     --------------------------------------------------------------------------- */
  var AMORCE = {
    'case-bdn': {
      nom: 'CASE du Bois de Nèfles', nom_court: 'CASE', embleme: '🍍',
      monde: 'chaleur', accent: '#127a51', accent_2: '#f4b740',
      tagline: '', logo: '', site: 'index.html'
    },
    bokaf: {
      nom: 'BOKAF', nom_court: 'BOKAF', embleme: '🎬',
      monde: 'cinema', accent: '#d81e5b', accent_2: '#2f6fdb',
      tagline: 'MÉDIA · ÉVÉNEMENT · PRODUCTION',
      logo: 'bokaf-logo.png', site: 'site-bokaf.html',
      mots: { projet: 'projet', projets: 'projets' }
    },
    pixiart: {
      nom: 'PIX-I-ART', nom_court: 'PIX-I-ART', embleme: '🔴',
      monde: 'cinema', accent: '#E8300A', accent_2: '#ff7a18',
      tagline: 'MADE IN RÉUNION ISLAND', logo: '', site: ''
    }
  };

  /* ---------------------------------------------------------------------------
     5. RÉSOLUTION
     --------------------------------------------------------------------------- */

  function estCouleur(v) { return !!versRgb(v); }

  /** Fusionne des sources par ordre de priorité : la 1re qui donne une valeur gagne. */
  function premier() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /**
   * Résout l'identité d'un tenant.
   * @param {object} sb      client supabase-js (peut être null → amorce/défaut seuls)
   * @param {object} asso    ligne `associations` déjà lue {id, name, slug, features}
   * @param {object} [opts]  {lireCharte:boolean} — tenter `fiches_marque` (staff only)
   * @returns {Promise<object>} identité complète, jamais null
   */
  async function resoudre(sb, asso, opts) {
    opts = opts || {};
    asso = asso || {};
    var features = asso.features || {};
    var enBase = (features && typeof features.identite === 'object' && features.identite) || {};
    var graine = AMORCE[String(asso.slug || '').toLowerCase()] || {};

    /* La charte de marque : un COMPLÉMENT, jamais un prérequis.
       Illisible (adhérent) ou absente → on continue sans, en silence.
       ⚠️ supabase-js ne LÈVE PAS : on teste `.error` à chaque appel. */
    var charte = {};
    if (sb && asso.id && opts.lireCharte) {
      try {
        var r = await sb.from('fiches_marque')
          .select('couleurs,logo_path,nom').eq('asso_id', asso.id).limit(1);
        if (!r.error && r.data && r.data.length) {
          var f = r.data[0];
          var pal = Array.isArray(f.couleurs) ? f.couleurs : [];
          var c0 = pal[0] && pal[0].hex, c1 = pal[1] && pal[1].hex;
          if (estCouleur(c0)) charte.accent = String(c0).trim();
          if (estCouleur(c1)) charte.accent_2 = String(c1).trim();
          if (f.logo_path) {
            try {
              var pu = sb.storage.from('chartes').getPublicUrl(f.logo_path);
              if (pu && pu.data && pu.data.publicUrl) charte.logo = pu.data.publicUrl;
            } catch (e) { /* bucket indisponible : on garde le logo d'ailleurs */ }
          }
        }
      } catch (e) { /* réseau : on continue sans la charte */ }
    }

    var id = {
      asso_id: asso.id || null,
      slug: asso.slug || null,
      nom: premier(enBase.nom, asso.name, graine.nom, DEFAUT.nom),
      nom_court: premier(enBase.nom_court, graine.nom_court, asso.name, DEFAUT.nom),
      embleme: premier(enBase.embleme, graine.embleme, DEFAUT.embleme),
      tagline: premier(enBase.tagline, graine.tagline, DEFAUT.tagline) || '',
      logo: premier(enBase.logo, charte.logo, graine.logo, DEFAUT.logo) || '',
      site: premier(enBase.site, graine.site, DEFAUT.site) || '',
      monde: premier(enBase.monde, graine.monde, DEFAUT.monde),
      accent: premier(
        estCouleur(enBase.accent) ? enBase.accent : null,
        charte.accent, graine.accent, DEFAUT.accent
      ),
      accent_2: premier(
        estCouleur(enBase.accent_2) ? enBase.accent_2 : null,
        charte.accent_2, graine.accent_2, DEFAUT.accent_2
      ),
      /* Vocabulaire : une entreprise dit « client » là où une asso dit « adhérent ». */
      mots: Object.assign({}, DEFAUT.mots, graine.mots || {}, enBase.mots || {}),
      /* Traçabilité — d'où vient l'habillage affiché (utile en support). */
      _source: Object.keys(enBase).length ? 'base'
             : (Object.keys(charte).length ? 'charte'
             : (Object.keys(graine).length ? 'amorce' : 'defaut'))
    };
    if (!MONDES[id.monde]) id.monde = DEFAUT.monde;
    return id;
  }

  /* ---------------------------------------------------------------------------
     6. APPLICATION — l'identité devient des variables CSS, rien d'autre
     Aucune règle de style ne vit ici : la page dessine avec les tokens, cette
     fonction ne fait que les poser. On peut donc rhabiller sans toucher au CSS.
     --------------------------------------------------------------------------- */
  function appliquer(id, doc) {
    doc = doc || document;
    var m = MONDES[id.monde] || MONDES[DEFAUT.monde];
    var rs = doc.documentElement.style;

    /* L'accent sert de TEXTE (liens, chiffres, sur-titres) sur plusieurs fonds :
       on le mesure contre le PIRE d'entre eux — celui qui en est le plus proche
       en clarté — sinon il passe sur le fond général et tombe sur les cartes.
       Mesuré le 07/08/2026 : calé sur `bg` seul, le magenta rendait 4,42:1 sur
       le rail (`bg2`). */
    var pires = [m.bg, m.bg2, m.surface, m.surface2];
    function pireFond(c) {
      return pires.slice().sort(function (x, y) { return contraste(c, x) - contraste(c, y); })[0];
    }
    var accentLisible = lisibleSur(id.accent, pireFond(id.accent), 4.5);
    var accent2Lisible = lisibleSur(id.accent_2, pireFond(id.accent_2), 4.5);
    // …et le couple d'un bouton plein (remplissage + libellé) doit passer AA.
    var bouton = remplissageLisible(id.accent, 4.5);

    var jetons = {
      '--bg': m.bg, '--bg-2': m.bg2, '--surface': m.surface, '--surface-2': m.surface2,
      '--ink': m.encre, '--muted': m.discret, '--muted-2': m.tres_discret,
      '--line': m.ligne, '--line-2': m.ligne_forte,
      '--shadow': m.ombre, '--shadow-lg': m.ombre_lg,
      '--font-display': m.display, '--font-body': m.corps, '--ls-titre': m.ls_titre,
      '--radius': m.radius, '--radius-pill': m.radius_pill, '--radius-champ': m.radius_champ,
      '--ease': m.ease, '--dur': m.duree,
      /* Sémantiques : elles portent un SENS (publié, en retard, alerte) et ne
         basculent JAMAIS en couleur de marque — on y perdrait le sens.
         ⚠️ Elles se mesurent comme la marque, et pour la MÊME raison : mesuré le
         07/08/2026, le vert « publié » rendait 3,46:1 sur sa propre teinte douce
         en peau claire, et l'encre de la pastille « nouveau » 3,68:1 sur le rouge
         clair. Les deux passaient en peau sombre — c'est l'arrivée d'un 2e monde
         qui les a fait apparaître. On calcule donc, pour chaque sémantique :
           --X       la couleur déclarée
           --X-soft  sa teinte douce (fond de pastille)
           --X-ink   la couleur du texte POSÉ sur cette teinte douce
           --X-fill / --X-fill-ink  le couple d'une pastille pleine */
      '--ok': m.ok, '--attention': m.attention, '--alerte': m.alerte,

      /* La marque, déclinée. L'asso ne pose qu'une ou deux couleurs ;
         tout le reste (survol, teinte douce, halo) en est dérivé. */
      '--brand': id.accent,                 /* la couleur DÉCLARÉE, intacte */
      '--brand-lisible': accentLisible.hex, /* la même, remontée pour du TEXTE sur le fond */
      '--brand-fill': bouton.fill,          /* la même, calée pour un REMPLISSAGE plein */
      '--brand-ink': bouton.ink,            /* le libellé qui se pose dessus */
      '--brand-hover': luminance(bouton.fill) > 0.5 ? assombrir(bouton.fill, .14) : eclaircir(bouton.fill, .12),
      '--brand-press': assombrir(bouton.fill, .24),
      '--brand-soft': melanger(id.accent, m.bg, .86),
      '--brand-soft-2': melanger(id.accent, m.bg, .74),
      '--brand-2': id.accent_2,
      '--brand-2-lisible': accent2Lisible.hex,
      '--grad': 'linear-gradient(120deg, ' + id.accent + ', ' + id.accent_2 + ')',
      '--halo': 'radial-gradient(closest-side at 82% -4%, ' + melanger(id.accent, m.bg, .78) + ', transparent 68%),'
              + 'radial-gradient(closest-side at 4% 96%, ' + melanger(id.accent_2, m.bg, .84) + ', transparent 62%)'
    };
    /* Les trois sémantiques, mesurées de la même façon que la marque. */
    ['ok', 'attention', 'alerte'].forEach(function (nom) {
      var base = m[nom];
      var doux = melanger(base, m.surface, .82);
      var encre = lisibleSur(base, doux, 4.5);          // texte sur la teinte douce
      var plein = remplissageLisible(base, 4.5);        // pastille pleine
      jetons['--' + nom + '-soft'] = doux;
      jetons['--' + nom + '-ink'] = encre.hex;
      jetons['--' + nom + '-fill'] = plein.fill;
      jetons['--' + nom + '-fill-ink'] = plein.ink;
    });

    Object.keys(jetons).forEach(function (k) { rs.setProperty(k, jetons[k]); });

    doc.documentElement.setAttribute('data-monde', id.monde);
    try {
      var mc = doc.querySelector('meta[name="theme-color"]');
      if (mc) mc.setAttribute('content', m.bg);
    } catch (e) { }

    return {
      identite: id, monde: m,
      /* Ce que la mesure a dû corriger — lisible en console, jamais silencieux. */
      contraste: {
        accent_sur_fond: Math.round(contraste(accentLisible.hex, m.bg) * 100) / 100,
        accent_ajuste: accentLisible.ajuste,
        bouton: Math.round(bouton.ratio * 100) / 100,
        bouton_ajuste: bouton.ajuste
      }
    };
  }

  /** Le bloc de marque (logo ou emblème + nom), rendu de façon uniforme. */
  function marqueHtml(id, taille) {
    taille = taille || 34;
    var s = 'width:' + taille + 'px;height:' + taille + 'px;border-radius:' + Math.round(taille * .28) + 'px;flex:none;';
    if (id.logo) {
      return '<img src="' + String(id.logo).replace(/"/g, '&quot;') + '" alt="" style="' + s + 'object-fit:cover">';
    }
    return '<span style="' + s + 'display:grid;place-items:center;background:var(--brand);'
         + 'font-size:' + Math.round(taille * .5) + 'px;line-height:1">' + (id.embleme || '🤖') + '</span>';
  }

  global.BobIdentite = {
    resoudre: resoudre,
    appliquer: appliquer,
    marqueHtml: marqueHtml,
    MONDES: MONDES,
    /* exposés pour les tests et pour d'autres écrans qui doivent mesurer */
    outils: {
      contraste: contraste, luminance: luminance, encreSur: encreSur,
      lisibleSur: lisibleSur, remplissageLisible: remplissageLisible,
      melanger: melanger, assombrir: assombrir,
      eclaircir: eclaircir, versRgb: versRgb, versHex: versHex
    }
  };
})(window);
