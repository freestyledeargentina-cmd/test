import express from "express";

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET || "secreto-123";

// Utils
function norm(s){ return (s||"").toString().trim().toLowerCase(); }
function stopwordsStrip(s){
  return norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\b(de|la|el|los|las|un|una|unos|unas|al|del|para|por|y|en|a|x)\b/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function tokens(s){
  let t = stopwordsStrip(s);
  t = t.replace(/\bmedianas?\b/g,'med')
       .replace(/\bgrandes?\b/g,'grande')
       .replace(/\bmilanesas?\b/g,'milanesa')
       .replace(/\bpicadas?\b/g,'picada')
       .replace(/\bcajas?\b/g,'cj')
       .replace(/\bkil(os?)?\b/g,'kg');
  return t.split(' ').filter(Boolean);
}
function jacc(A, B){
  const a = new Set(A), b = new Set(B);
  let inter = 0; a.forEach(x=>{ if (b.has(x)) inter++; });
  const uni = new Set([...a,...b]).size || 1;
  return inter/uni;
}
function unidadFromText(u){
  u = norm(u);
  if (/kg|kgr|kilo/.test(u)) return 'KG';
  if (/cj|caja/.test(u)) return 'CJ';
  return 'UN';
}
const UNIT_RE = '(kg|kgs|kg\\.|kgr|kgrs|kilo|kilos|cj|cjs|caja|cajas|u|unid|unidad|unidades)';
const QTY_RE  = '(\\d+(?:[.,]\\d+)?)';
const ITEM_RE = new RegExp(`${QTY_RE}\\s*${UNIT_RE}?\\s+([^\\d|]+?)(?=\\s+${QTY_RE}\\s*${UNIT_RE}?\\b|$)`, 'gi');

function tokenizeLine(txt){
  const out = [];
  const s = norm(txt).replace(/\s+/g,' ').trim();
  let m;
  while ((m = ITEM_RE.exec(s)) !== null){
    const qty = parseFloat(m[1].replace(',', '.'));
    const uni = unidadFromText(m[2]||'');
    let desc= (m[3]||'').trim().replace(/^(de|la|el|los|las)\s+/i,'');
    if (!qty || !desc) continue;
    out.push({ qty, uni, desc });
  }
  return out;
}

// === Cliente HTTP contra tu Apps Script (API de datos) ===
async function dataApiGET(url, fn, params){
  const u = new URL(url);
  u.searchParams.set('fn', fn);
  u.searchParams.set('key', API_SECRET);
  Object.entries(params||{}).forEach(([k,v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString());
  return r.json();
}
async function dataApiPOST(url, fn, body){
  const u = new URL(url);
  u.searchParams.set('fn', fn);
  u.searchParams.set('key', API_SECRET);
  const r = await fetch(u.toString(), {
    method:'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(body||{})
  });
  return r.json();
}

const SPA_DOW = { lunes:1, martes:2, miercoles:3, miércoles:3, jueves:4, viernes:5, sabado:6, sábado:6, domingo:7 };
function windowForDias(now, dias){
  if (!dias || !dias.length) return { allowed:true };
  for (let add=0; add<=14; add++){
    const base = new Date(now.getTime() + add*24*3600*1000);
    const dow = base.getDay()===0 ? 7 : base.getDay();
    const match = dias.some(d => SPA_DOW[d] === dow);
    if (!match) continue;
    const dayBefore = new Date(base.getTime() - 24*3600*1000);
    const ws = new Date(dayBefore.getFullYear(), dayBefore.getMonth(), dayBefore.getDate(), 9, 0, 0);
    const we = new Date(dayBefore.getFullYear(), dayBefore.getMonth(), dayBefore.getDate(), 14, 30, 0);
    if (now >= ws && now <= we) return { allowed:true, deliveryDate: base, windowStart: ws, windowEnd: we };
    if (now < ws) return { allowed:false, deliveryDate: base, windowStart: ws, windowEnd: we };
  }
  return { allowed:true };
}

function pickBlock(items){
  if (!items?.length) return '(sin ítems)';
  return items.map(it => `* ${String(it.nombre||'').toUpperCase()} x ${it.cantidad} ${it.unidad||'UN'}`).join('\n');
}
function bestMatch(catalog, desc){
  const q = tokens(desc);
  let best=null, score=0;
  for (const it of catalog){
    const s = jacc(q, tokens(it.nombre));
    if (s>score){ score=s; best=it; }
  }
  const ok = best && score >= 0.3 && q.some(t => tokens(best.nombre).includes(t));
  return ok ? best : null;
}
function parseToItems(catalog, text){
  const toks = tokenizeLine(text);
  const items=[], unknown=[];
  for (const t of toks){
    const it = bestMatch(catalog, t.desc);
    if (!it){ unknown.push(t.desc); continue; }
    const unidadCatalogo = /KG/.test(it.medida||'') ? 'KG' : /CJ/.test(it.medida||'') ? 'CJ' : /UNI/.test(it.medida||'') ? 'UNI' : '';
    items.push({
      nombre: it.nombre,
      cantidad: Number(t.qty||1),
      unidad: t.uni || unidadCatalogo || 'UN',
      precio: Number(it.precio||0)
    });
  }
  return { items, unknown };
}
function mergeItems(a){
  const map = new Map();
  for (const it of a){
    const key = `${norm(it.nombre)}|${it.unidad||'UN'}`;
    if (!map.has(key)) map.set(key, { ...it });
    else {
      const cur = map.get(key);
      cur.cantidad += Number(it.cantidad||0);
      map.set(key, cur);
    }
  }
  return [...map.values()];
}

// Entrada principal del agente (Apps Script te llama acá)
app.post("/", async (req, res) => {
  try{
    const { key, from, chatId, text, dataApi } = req.body||{};
    if (!key || key !== API_SECRET) return res.status(401).json({ ok:false });

    const cliente = await dataApiGET(dataApi, 'cliente', { tel: from }) || {};
    const catalog = await dataApiGET(dataApi, 'catalog', {}) || [];
    const pedido  = await dataApiGET(dataApi, 'pedido.get', { tel: from });

    const nombre = cliente?.nombre || '';
    const now = new Date();
    const win = windowForDias(now, cliente?.dias||[]);

    if (!win.allowed){
      const ws = win.windowStart?.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
      const we = win.windowEnd?.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
      const dd = win.deliveryDate?.toLocaleDateString('es-AR',{weekday:'long', day:'numeric', month:'long'});
      const greet = /hola|buen/i.test(text) ? `¡Hola ${nombre||''}! ` : `Hola${nombre? ' '+nombre:''}. `;
      return res.json({ reply: `${greet}Tomamos pedidos *el día anterior* de 09:00 a 14:30.\nPróxima ventana: *${dd} ${ws}–${we}*.` });
    }

    const txt = norm(text);

    // Si hay pedido en curso (pendiente o ya guardado), operar sobre él
    if (pedido && (pedido.estado === 'PENDIENTE' || pedido.items?.length)){
      if (/\b(s[íi]|ok|dale|confirmo|listo)\b/.test(txt)){
        await dataApiPOST(dataApi, 'pedido.upsert', { tel: from, nombre, items: pedido.items, estado: 'CONFIRMADO' });
        return res.json({ reply: `¡Perfecto, ${nombre||'gracias'}! Pedido confirmado ✅\n${pickBlock(pedido.items)}` });
      }
      if (/\b(no|cancel|espera|par[aao])\b/.test(txt)){
        return res.json({ reply: `Ok, ${nombre||'todo bien'}. Decime qué corrijo o mandá *producto + cantidad*.` });
      }
      // Quitar cantidades de un producto
      let m = txt.match(/\bsac[aá]s?\s+(\d+)\s*(kg|kilo|kilos|cj|caja|cajas|u|unid|unidad|unidades)?\s*(?:de\s+)?(.+)/);
      if (m){
        const n = Number(m[1]); const uni = unidadFromText(m[2]||''); const q = m[3]||'';
        const target = bestMatch(catalog, q);
        if (!target) return res.json({ reply: `No encontré "${q}" en tu pedido.` });
        const key = `${norm(target.nombre)}|${uni||'UN'}`;
        const items = (pedido.items||[]).map(x=>({ ...x }));
        let found = false;
        for (const it of items){
          const k2 = `${norm(it.nombre)}|${it.unidad||'UN'}`;
          if (k2 === key){ it.cantidad = Math.max(0, it.cantidad - n); found = true; }
        }
        const items2 = items.filter(it => it.cantidad > 0);
        if (!found) return res.json({ reply: `Ese producto/unidad no está en tu pedido.` });
        await dataApiPOST(dataApi, 'pedido.upsert', { tel: from, nombre, items: items2, estado: 'PENDIENTE' });
        return res.json({ reply: `Listo. ¿Así va?\n${pickBlock(items2)}` });
      }
      // Agregar o línea de productos
      const addMatch = txt.match(/\b(agregame|sumame|\+)\s+(.+)/);
      const line = addMatch ? addMatch[2] : text;
      const parsed = parseToItems(catalog, line);
      if (parsed.items.length){
        const merged = mergeItems([...(pedido.items||[]), ...parsed.items]);
        await dataApiPOST(dataApi, 'pedido.upsert', { tel: from, nombre, items: merged, estado: 'PENDIENTE' });
        return res.json({ reply: `Actualicé tu pedido. ¿Confirmás?\n${pickBlock(merged)}` });
      }
      if (parsed.unknown?.length){
        return res.json({ reply: `No vendemos:\n${parsed.unknown.map(x=>`* ${x}`).join('\n')}\nMandá producto + cantidad del catálogo.` });
      }
      return res.json({ reply: `Decime qué corrijo (ej: "sacá 2 cj milanesa de peceto", "cambiá picada por especial", "agregame 2 cj milanesas").` });
    }

    // Sin pendiente: saludar/crear
    if (/hola|buenas|buen d[ií]a/.test(txt)){
      return res.json({ reply: `¡Hola ${nombre||''}! Decime producto + cantidad en una línea.\nEj: "20kg picada especial" · "2 cj milanesas medianas"` });
    }

    const parsed = parseToItems(catalog, text);
    if (parsed.items.length){
      await dataApiPOST(dataApi, 'pedido.upsert', { tel: from, nombre, items: parsed.items, estado: 'PENDIENTE' });
      return res.json({ reply: `Detecté esto:\n${pickBlock(parsed.items)}\n¿Confirmás?` });
    }
    if (parsed.unknown?.length){
      return res.json({ reply: `No vendemos:\n${parsed.unknown.map(x=>`* ${x}`).join('\n')}\nMandá producto + cantidad del catálogo.` });
    }
    return res.json({ reply: `Decime *producto + cantidad* en una línea.` });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Agent running on", PORT));
