/* ════════════════════════════════════════════════════════════════
   TBR TOOLS · Catálogo Digital — Lógica
   Fuente de datos (en orden):
   1) Firebase en vivo (se actualiza solo desde TBR Tools Manager)
   2) catalogo-data.js (CATALOG_DATA) generado manualmente
   3) Datos de ejemplo
═════════════════════════════════════════════════════════════════ */
const FB_LIVE = 'https://tbr-tools-manager-default-rtdb.firebaseio.com/tbr';

const SAMPLE_PRODUCTS = [
  {name:'Amoladora Inalámbrica 20V 1000W Total', code:'TAGLI271532', salePrice:280622, stock:5},
  {name:'Taladro Percutor Inalámbrico 20V 86Nm Total', code:'TIDLI208687', salePrice:275425, stock:1},
  {name:'Taladro Atornillador Inalámbrico 20V 50Nm Total', code:'TDLI205062', salePrice:176688, stock:5},
  {name:'Equipo De Pintar 530W 800ML Total', code:'TT45061', salePrice:75448, stock:4},
  {name:'Equipo De Pintar 450W 800ML Total', code:'TT3506', salePrice:69290, stock:3},
];

const STATIC = (typeof CATALOG_DATA !== 'undefined') ? CATALOG_DATA : null;
let EMPRESA = (STATIC && STATIC.empresa) || { nombre:'TBR Tools', whatsapp:'5492604375765' };
let PRODUCTS = (STATIC && STATIC.products) || SAMPLE_PRODUCTS;

/* ── Helpers ── */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => '$ ' + Math.round(n||0).toLocaleString('es-AR');
const esc = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad3 = n => String(n).padStart(3,'0');

/* ── Precios: efectivo (base) vs tarjeta en cuotas ── */
const getCuotasCant = () => EMPRESA.cuotasCant || 6;
const getRecargoPct = () => (EMPRESA.cuotasRecargoPct>0) ? EMPRESA.cuotasRecargoPct : 15;
const precioTarjeta = ef => Math.round((ef||0) * (1 + getRecargoPct()/100));
const valorCuota   = ef => Math.round(precioTarjeta(ef) / getCuotasCant());
const ahorroPct    = () => Math.round(getRecargoPct()/(100+getRecargoPct())*100);

/* ── Catálogo en vivo desde Firebase ──
   mapLiveCatalog/mapLiveEmpresa traducen los nodos crudos de /tbr/catalog
   y /tbr/empresa al formato que usa el catálogo. Se usan tanto por el
   fetch inicial (REST, por si la DB SDK no carga) como por los listeners
   en tiempo real (onValue) que mantienen todo sincronizado. ── */
function mapLiveCatalog(cat){
  if(!Array.isArray(cat)) return null;
  const products = cat.filter(x=>x&&x.salePrice).map(x=>({
    name:x.name, code:x.code||'', salePrice:x.salePrice,
    stock:x.stock!=null?x.stock:undefined,
    photo:x.photo||undefined,
    photos:(x.photos&&x.photos.length>1)?x.photos:undefined,
    description:x.specs||undefined
  }));
  return products.length ? products : null;
}
function mapLiveEmpresa(emp){
  return {
    nombre:EMPRESA.nombre,
    whatsapp:(emp&&emp.waNegocio)?emp.waNegocio.replace(/\D/g,''):EMPRESA.whatsapp,
    cuotasCant:(emp&&emp.cuotasCant)||0,
    cuotasRecargoPct:(emp&&emp.cuotasRecargoPct)||0
  };
}
async function fetchLive(){
  try{
    const [c,e] = await Promise.all([
      fetch(`${FB_LIVE}/catalog.json`,{cache:'no-store',signal:AbortSignal.timeout(4000)}),
      fetch(`${FB_LIVE}/empresa.json`,{cache:'no-store',signal:AbortSignal.timeout(4000)})
    ]);
    if(!c.ok) return null;
    const products = mapLiveCatalog(await c.json());
    if(!products) return null;
    const emp = e.ok ? await e.json() : null;
    return { empresa: mapLiveEmpresa(emp), products };
  }catch{ return null; }
}

/* ── Derivar specs técnicas desde el nombre ── */
function parseSpecs(name){
  const n = ' '+name+' ';
  const specs = [];
  const grab = (re,unit,key)=>{ const m = n.match(re); if(m) specs.push({k:key,v:m[1]+unit}); };
  grab(/(\d+)\s?V\b/i,' V','Voltaje');
  grab(/(\d+(?:[.,]\d+)?)\s?Ah\b/i,' Ah','Batería');
  grab(/(\d+)\s?W\b/i,' W','Potencia');
  grab(/(\d+)\s?Nm\b/i,' Nm','Torque');
  grab(/(\d+(?:[.,]\d+)?)\s?(?:ML|ml)\b/,' ml','Capacidad');
  grab(/(\d+)\s?(?:RPM|rpm)\b/,' rpm','Velocidad');
  grab(/(\d+)\s?(?:mm)\b/i,' mm','Medida');
  grab(/(\d+(?:[.,]\d+)?)\s?(?:["”]|pulg)\b/i,'"','Disco');
  return specs;
}

/* ── Derivar categoría desde el nombre ── */
const CAT_RULES = [
  [/amoladora/i,'Amoladoras'],
  [/taladro|atornillador|rotomartillo|percutor/i,'Taladros'],
  [/pintar|pintura|compresor/i,'Pintura'],
  [/sierra|caladora|ingletadora/i,'Sierras'],
  [/lijadora|pulidora/i,'Lijado'],
  [/llave\s?de\s?impacto|impacto/i,'Impacto'],
  [/soldadora|soldar|inverter/i,'Soldadura'],
  [/medici|nivel|láser|laser|metro/i,'Medición'],
  [/aspirad|sopladora|hidrolav/i,'Limpieza'],
  [/bateria|batería|cargador/i,'Baterías'],
];
function categoryOf(name){
  for(const [re,cat] of CAT_RULES){ if(re.test(name)) return cat; }
  return 'Herramientas';
}
function brandOf(name){
  const m = name.match(/\b(total|bosch|dewalt|makita|stanley|black\s?\+?\s?decker|einhell|hikoki|milwaukee)\b/i);
  return m ? m[1].replace(/\s+/g,' ').toUpperCase() : null;
}

/* ── Normalizar productos: índice, specs, categoría, fotos ── */
let ITEMS = [];
function buildItems(){
  ITEMS = PRODUCTS.map((p,i)=>{
    const photos = (p.photos&&p.photos.length)?p.photos:(p.photo?[p.photo]:[]);
    const videos = (p.videos&&p.videos.length)?p.videos:(p.video?[p.video]:[]);
    const specs = parseSpecs(p.name||'');
    return {
      ...p, i,
      photos, videos,
      cat:categoryOf(p.name||''),
      brand:brandOf(p.name||''),
      specs,
      isBattery: /(\d+)\s?V\b/i.test(p.name||'') || /bater|inal[aá]mbric|20v|18v/i.test(p.name||''),
      initial:(p.name||'?').trim().charAt(0).toUpperCase()
    };
  });
  uniqifyNames();
}

/* ── Nombre único por producto: si el título corto colapsa con otro,
   le agrega la spec que los diferencia (ej. "· 530 W") ── */
function uniqifyNames(){
  const groups = {};
  ITEMS.forEach(it=>{ it._base = shortName(it.name); (groups[it._base] = groups[it._base] || []).push(it); });
  ITEMS.forEach(it=>{
    const grp = groups[it._base];
    if(grp.length < 2){ it.displayName = it._base; return; }
    let suffix = '';
    for(const s of it.specs){
      const vals = new Set(grp.map(g=>(g.specs.find(x=>x.k===s.k)||{}).v).filter(Boolean));
      if(vals.size > 1){ suffix = s.v; break; }
    }
    if(!suffix && it.code) suffix = it.code;
    it.displayName = suffix ? `${it._base} · ${suffix}` : it._base;
  });
}
function videoOf(item){ return (item.videos && item.videos[0]) || null; }
function videoTag(src, poster, cls){
  return `<video class="${cls||'card-img'}" autoplay muted loop playsinline preload="metadata"${poster?` poster='${poster}'`:''}><source src='${src}' type='video/mp4'></video>`;
}
function mediaHTML(item){
  const v = videoOf(item);
  if(v) return videoTag(v, item.photos[0], 'card-img');
  if(item.photos[0]) return photoLayers(item.photos[0], 'card-photo');
  return `<div class="ph">
    <div class="ph-glyph">${esc(item.initial)}</div>
    <div class="ph-tag">${item.code?esc(item.code):'FOTO PRODUCTO'}</div>
  </div>`;
}
function bgImageFor(item){
  return item.photos[0] || null;
}

/* ── Nombre corto (saca specs y marca para destacar el producto) ── */
function shortName(name){
  let s = ' '+(name||'')+' ';
  s = s.replace(/\b(total|bosch|dewalt|makita|stanley|black\s?\+?\s?decker|einhell|hikoki|milwaukee)\b/ig,' ');
  s = s.replace(/\b\d+(?:[.,]\d+)?\s?(?:V|Ah|W|Nm|ML|RPM|mm|pulg)\b/ig,' ');
  s = s.replace(/["”]/g,' ').replace(/\s{2,}/g,' ').trim();
  return s || (name||'');
}

/* ── Capas de foto: fondo difuminado de la propia imagen + producto nítido y completo ── */
function photoLayers(url, sharpCls){
  return `<div class="kb-blur" style="background-image:url('${url}')"></div>`+
         `<div class="${sharpCls}" style="background-image:url('${url}')"></div>`;
}

/* ── Chip de stock ── */
function stockChip(item){
  if(item.stock==null) return '';
  if(item.stock<=0) return `<span class="stock-chip r">Sin stock</span>`;
  if(item.stock<=2) return `<span class="stock-chip y">Últimas ${item.stock}</span>`;
  return `<span class="stock-chip g">Disponible</span>`;
}

/* ════════════════════════════════════════════════════════════════
   HERO / PORTADA — rotación de destacados
═════════════════════════════════════════════════════════════════ */
let featured = [];
let heroIdx = 0, bgToggle = false, heroTimer = null;

function buildFeatured(){
  // Destacados: con stock, ordenados por precio desc, hasta 5
  const withStock = ITEMS.filter(x=>x.stock==null||x.stock>0);
  featured = (withStock.length?withStock:ITEMS).slice().sort((a,b)=>b.salePrice-a.salePrice).slice(0,5);
  if(!featured.length) featured = ITEMS.slice(0,1);
}

function setHeroBg(item){
  const a=$('#bgA'), b=$('#bgB');
  const showing = bgToggle?b:a, hiding = bgToggle?a:b;
  const v = videoOf(item), img = bgImageFor(item);
  showing.innerHTML = v
    ? videoTag(v, img, 'kb hero-video')
    : (img
      ? photoLayers(img, 'kb')
      : `<div class="kb" style="background:radial-gradient(ellipse 80% 70% at 62% 36%,#211d17,#0b0a09 74%)"></div>`);
  // Posición y tamaño custom por producto (campos heroX, heroY, heroSize en Firebase)
  const kb = showing.querySelector('.kb:not(.kb-blur)');
  if(kb && img){
    if(item.heroX || item.heroY) kb.style.backgroundPosition = `${item.heroX||'10%'} ${item.heroY||'22%'}`;
    if(item.heroSize) kb.style.backgroundSize = item.heroSize;
  }
  showing.classList.add('on'); hiding.classList.remove('on');
  bgToggle=!bgToggle;
}

function _heroMainHTML(item){
  const specsHTML = item.specs.slice(0,3).map(s=>
    `<div class="spec"><div class="spec-v">${esc(s.v)}</div><div class="spec-k">${esc(s.k)}</div></div>`
  ).join('') || `<div class="spec"><div class="spec-v">${esc(item.cat)}</div><div class="spec-k">Categoría</div></div>`;
  return `
    <div class="hero-kicker bfu" style="animation-delay:.05s">
      <span class="kicker">Destacado</span>
    </div>
    <div class="hero-meta bfu" style="animation-delay:.12s">
      ${item.brand?`<span class="chip chip-brand"><i>Marca</i>${esc(item.brand)}</span>`:''}
      <span class="chip code">${esc(item.code||'—')}</span>
      ${stockChip(item)}
    </div>
    <h1 class="hero-title bfu" style="animation-delay:.18s">${esc(item.displayName||shortName(item.name))}</h1>
    <div class="hero-specs bfu" style="animation-delay:.26s">${specsHTML}</div>
    <div class="hero-bottom bfu" style="animation-delay:.34s">
      <div class="hero-price">
        <small>Efectivo / transferencia</small>
        <div class="price-row"><span class="metal-gold hero-price-val" data-price="${fmt(item.salePrice)}">${fmt(item.salePrice)}</span><span class="save-badge">${ahorroPct()}% OFF</span></div>
        <span class="pay-line">Tarjeta ${fmt(precioTarjeta(item.salePrice))} · ${getCuotasCant()} cuotas sin interés de ${fmt(valorCuota(item.salePrice))}</span>
      </div>
      <div class="hero-cta-row">
        <button class="btn btn-gold" onclick="openDetail(${item.i})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          Ver ficha
        </button>
        <button class="btn glass btn-glass" onclick="addToCart(${item.i});event.stopPropagation()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Agregar
        </button>
      </div>
    </div>`;
}

let _heroTransiting = false, _heroTransitTimer = null;
function renderHero(instant){
  if(!featured.length) return;
  const item = featured[heroIdx];

  // Rieles siempre inmediatos
  $('#railDots').innerHTML = featured.map((_,i)=>
    `<button class="rail-dot ${i===heroIdx?'active':''}" onclick="goHero(${i})" aria-label="Destacado ${i+1}"><i></i></button>`
  ).join('');
  $('#railNow').textContent = `${pad3(heroIdx+1)} / ${pad3(featured.length)}`;

  if(instant || _heroTransiting){
    // Primera carga o transición encadenada: sin animación de salida
    setHeroBg(item);
    $('#heroMain').innerHTML = _heroMainHTML(item);
    if(!instant){ const pv=$('.hero-price-val'); if(pv) animateHeroPrice(pv, pv.dataset.price||''); }
    return;
  }

  _heroTransiting = true;
  const heroMain = $('#heroMain');

  // 1. Fade-out del texto actual
  heroMain.style.transition = 'opacity .22s ease, transform .22s ease';
  heroMain.style.opacity = '0';
  heroMain.style.transform = 'translateY(10px)';

  // 2. Flash overlay sobre el hero para suavizar el crossfade del fondo
  const hero = document.querySelector('.hero');
  const flash = document.createElement('div');
  flash.className = 'hero-flash';
  hero.appendChild(flash);
  requestAnimationFrame(()=>{ flash.classList.add('hero-flash-go'); });

  _heroTransitTimer = setTimeout(()=>{
    _heroTransitTimer = null;
    // 3. Swap fondo e inyectar nuevo texto
    setHeroBg(item);
    heroMain.style.transition = '';
    heroMain.style.opacity = '';
    heroMain.style.transform = '';
    heroMain.innerHTML = _heroMainHTML(item);
    const pv = heroMain.querySelector('.hero-price-val');
    if(pv) animateHeroPrice(pv, pv.dataset.price||'');

    // 4. Limpiar flash
    setTimeout(()=>{ flash.remove(); _heroTransiting = false; }, 700);
  }, 240);
}

function goHero(i){ heroIdx=(i+featured.length)%featured.length; renderHero(); restartHeroTimer(); }
function nextHero(){ goHero(heroIdx+1); }
function prevHero(){ goHero(heroIdx-1); }
function initHeroSwipe(){
  const hero=document.querySelector('.hero'); if(!hero||hero._swipe) return; hero._swipe=true;
  let x0=null,y0=null;
  hero.addEventListener('touchstart',e=>{ x0=e.touches[0].clientX; y0=e.touches[0].clientY; },{passive:true});
  hero.addEventListener('touchend',e=>{
    if(x0==null) return;
    const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0;
    if(Math.abs(dx)>48 && Math.abs(dx)>Math.abs(dy)*1.4){ dx<0?nextHero():prevHero(); }
    x0=null; y0=null;
  },{passive:true});
}
function restartHeroTimer(){
  clearInterval(heroTimer);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  heroTimer = setInterval(()=>{ if(!detailOpen && !cartOpen) nextHero(); }, 6500);
}


/* ════════════════════════════════════════════════════════════════
   COLECCIÓN — grilla, filtros, búsqueda, orden
═════════════════════════════════════════════════════════════════ */
let activeCat = 'Todos', query = '', sortBy = 'rel', stockOnly = false;

function buildCats(){
  const counts = {};
  ITEMS.forEach(x=>{ counts[x.cat]=(counts[x.cat]||0)+1; });
  const cats = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
  $('#cats').innerHTML =
    `<button class="cat ${activeCat==='Todos'?'active':''}" onclick="setCat('Todos')">Todos · ${ITEMS.length}</button>` +
    cats.map(c=>`<button class="cat ${activeCat===c?'active':''}" onclick="setCat('${esc(c)}')">${esc(c)} · ${counts[c]}</button>`).join('');
}
function setCat(c){ activeCat=c; buildCats(); renderGrid(); }
function setSort(v){ sortBy=v; renderGrid(); }
function onSearch(v){ query=v.trim().toLowerCase(); renderGrid(); renderAutocomplete(v.trim()); }

function renderAutocomplete(raw){
  const ac = $('#searchAC'); if(!ac) return;
  if(!raw){ ac.innerHTML=''; ac.hidden=true; return; }
  const q = raw.toLowerCase();
  const hits = ITEMS.filter(x=>
    (x.name||'').toLowerCase().includes(q)||(x.code||'').toLowerCase().includes(q)
  ).slice(0,5);
  if(!hits.length){ ac.innerHTML=''; ac.hidden=true; return; }
  ac.innerHTML = hits.map(item=>`
    <div class="ac-item" onclick="openDetail(${item.i});closeAutocomplete()">
      <div class="ac-thumb">${item.photos[0]?`<img src="${item.photos[0]}" alt="" loading="lazy">`:`<div class="ac-initial">${esc(item.initial)}</div>`}</div>
      <div class="ac-info">
        <div class="ac-name">${esc(item.displayName||shortName(item.name))}</div>
        <div class="ac-price metal-gold">${fmt(item.salePrice)}</div>
      </div>
    </div>`).join('');
  ac.hidden = false;
}
function closeAutocomplete(){
  const ac=$('#searchAC'); if(ac){ ac.innerHTML=''; ac.hidden=true; }
  const inp=$('.search-box input'); if(inp){ inp.value=''; query=''; renderGrid(); }
}
function toggleStock(){
  stockOnly=!stockOnly;
  const b=$('#stockToggle'); if(b) b.classList.toggle('active', stockOnly);
  renderGrid();
}

function filtered(){
  let list = ITEMS.filter(x=>{
    const okCat = activeCat==='Todos' || x.cat===activeCat;
    const okQ = !query || (x.name||'').toLowerCase().includes(query) || (x.code||'').toLowerCase().includes(query);
    const okStock = !stockOnly || x.stock==null || x.stock>0;
    return okCat && okQ && okStock;
  });
  if(sortBy==='priceAsc') list.sort((a,b)=>a.salePrice-b.salePrice);
  else if(sortBy==='priceDesc') list.sort((a,b)=>b.salePrice-a.salePrice);
  else if(sortBy==='name') list.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  return list;
}

function stockBadge(item){
  if(item.stock==null || item.stock>2) return '';
  if(item.stock<=0) return '';
  const txt = item.stock===1 ? 'Último' : `Quedan ${item.stock}`;
  return `<span class="stock-badge">${txt}</span>`;
}

function cardHTML(item){
  const specChips = (item.specs.length
    ? item.specs.slice(0,3).map(s=>`<span class="sc">${esc(s.v)}</span>`)
    : [`<span class="sc">${esc(item.cat)}</span>`]).join('');
  return `<article class="card reveal" onclick="openDetail(${item.i},false,this)">
    <div class="card-media">
      ${mediaHTML(item)}
      <div class="card-top">
        <span class="card-no mono">${pad3(item.i+1)}</span>
        <button class="card-quick" onclick="openDetail(${item.i},false,this.closest('.card'));event.stopPropagation()" aria-label="Ver ficha">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      ${stockBadge(item)}
    </div>
    <div class="card-body">
      <div class="card-cat">${esc(item.cat)}${item.brand?' · '+esc(item.brand):''}</div>
      <h3 class="card-name">${esc(item.displayName||shortName(item.name))}</h3>
      <div class="card-specchips">${specChips}</div>
      <div class="card-foot">
        <div class="card-price"><small>Efectivo</small>${fmt(item.salePrice)}<span class="card-cuotas">${getCuotasCant()} cuotas s/interés de ${fmt(valorCuota(item.salePrice))}</span></div>
        <button class="card-add" data-add="${item.i}" onclick="addToCart(${item.i},1,this.closest('.card')?.querySelector('.card-media'));event.stopPropagation()" aria-label="Agregar al pedido">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>
  </article>`;
}

function renderGrid(){
  const list = filtered();
  const grid = $('#grid');
  grid.innerHTML = list.length ? list.map(cardHTML).join('')
    : `<div class="empty">Sin resultados para tu búsqueda</div>`;
  $('#secCount').textContent = `${pad3(list.length)} ${list.length===1?'producto':'productos'}`;
  syncAddButtons();
  observeReveal();
}

/* ════════════════════════════════════════════════════════════════
   DETALLE INMERSIVO
═════════════════════════════════════════════════════════════════ */
let detailOpen = false, detailItem = null, detailPhoto = 0, detailQty = 1;

function _cancelHeroTransition(){
  _heroTransiting = false;
  if(_heroTransitTimer){ clearTimeout(_heroTransitTimer); _heroTransitTimer = null; }
  const heroMain = $('#heroMain');
  if(heroMain){ heroMain.style.transition=''; heroMain.style.opacity=''; heroMain.style.transform=''; }
  document.querySelectorAll('.hero-flash').forEach(el=>el.remove());
}
function openDetail(i, fromHash, clickedCardEl){
  detailItem = ITEMS[i]; if(!detailItem) return;
  saveHistory(i);
  _cancelHeroTransition();
  detailPhoto = 0; detailQty = 1; detailOpen = true;
  // Task 6: card→detail image expansion transition
  if(clickedCardEl && detailItem.photos[0] && !matchMedia('(prefers-reduced-motion: reduce)').matches){
    const mediaEl = clickedCardEl.querySelector('.card-media') || clickedCardEl;
    const r = mediaEl.getBoundingClientRect();
    const fly = document.createElement('div');
    fly.className = 'detail-fly-img';
    fly.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background-image:url('${detailItem.photos[0]}')`;
    document.body.appendChild(fly);
    fly.animate([
      {transform:'translate(0,0)',width:r.width+'px',height:r.height+'px',borderRadius:'16px',opacity:1},
      {transform:`translate(${-r.left}px,${-r.top}px)`,width:'100vw',height:'100vh',borderRadius:'0px',opacity:0}
    ],{duration:300,easing:'ease-out',fill:'forwards'}).onfinish=()=>fly.remove();
  }
  renderDetail();
  $('#detail').scrollTop = 0;
  document.body.style.overflow='hidden';
  // Double RAF: asegura que el browser pinte el frame inicial antes de
  // agregar 'open', para que la transición slide-up arranque desde el borde.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ $('#detail').classList.add('open'); }));
  // Deep link: refleja el producto en la URL (sin saltar el scroll)
  if(!fromHash && detailItem.code){
    try{ history.replaceState(null,'', '#'+encodeURIComponent(detailItem.code)); }catch{}
  }
}
function closeDetail(){
  detailOpen=false;
  $('#detail').classList.remove('open');
  if(!cartOpen) document.body.style.overflow='';
  if(location.hash){ try{ history.replaceState(null,'', location.pathname+location.search); }catch{} }
  renderHistory();
}

function toggleSpecPanel(){
  const panel = $('#specPanel'); if(!panel) return;
  const body = panel.querySelector('.spec-panel-body');
  const btn = panel.querySelector('.spec-panel-toggle');
  const expanded = btn.getAttribute('aria-expanded')==='true';
  btn.setAttribute('aria-expanded', String(!expanded));
  body.style.maxHeight = expanded ? '0' : body.scrollHeight+'px';
  panel.classList.toggle('open', !expanded);
}

/* ── Historial de vistos ── */
const HISTORY_KEY = 'tbr_history';
function saveHistory(i){
  let h = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
  h = [i, ...h.filter(x=>x!==i)].slice(0,6);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
}
function renderHistory(){
  const sec = $('#historySec');
  if(sec) sec.innerHTML = '';
  return; // deshabilitado
  const h = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
  const valid = h.map(i=>ITEMS[i]).filter(Boolean);
  if(!sec) return;
  if(!valid.length){ sec.innerHTML=''; return; }
  sec.innerHTML = `
    <div class="history-head"><span class="kicker">Vistos recientemente</span></div>
    <div class="history-grid">${valid.map(item=>`
      <article class="history-card" onclick="openDetail(${item.i},false,this)">
        <div class="history-thumb">${item.photos[0]?`<img src="${item.photos[0]}" alt="" loading="lazy">`:`<div class="ph-glyph">${esc(item.initial)}</div>`}</div>
        <div class="history-info">
          <div class="history-name">${esc(item.displayName||shortName(item.name))}</div>
          <div class="history-price metal-gold">${fmt(item.salePrice)}</div>
        </div>
      </article>`).join('')}
    </div>`;
}

/* ── Link compartible con filtros ── */
function applyUrlFilters(){
  const p = new URLSearchParams(location.search);
  if(p.get('cat') && p.get('cat')!=='Todos') setCat(p.get('cat'));
  if(p.get('q')){ query=p.get('q'); const inp=$('.search-box input'); if(inp) inp.value=query; }
  if(p.get('stock')==='1'){ stockOnly=true; const b=$('#stockToggle'); if(b) b.classList.add('active'); }
}
function shareView(){
  const p = new URLSearchParams();
  if(activeCat && activeCat!=='Todos') p.set('cat', activeCat);
  if(query) p.set('q', query);
  if(stockOnly) p.set('stock','1');
  const url = location.origin+location.pathname+(p.toString()?'?'+p.toString():'');
  if(navigator.clipboard){
    navigator.clipboard.writeText(url).then(()=>showShareFeedback()).catch(()=>fallbackCopy(url));
  } else fallbackCopy(url);
}
function fallbackCopy(url){
  const ta = document.createElement('textarea');
  ta.value=url; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); showShareFeedback(); }catch{}
  document.body.removeChild(ta);
}
function showShareFeedback(){
  const btn = $('#shareViewBtn'); if(!btn) return;
  const orig = btn.innerHTML;
  btn.textContent = '¡Copiado!';
  btn.style.color = 'var(--gd)';
  setTimeout(()=>{ btn.innerHTML=orig; btn.style.color=''; }, 2000);
}

/* ── Contador animado en precio del hero (odómetro) ── */
let _lastHeroPrice = null;
function animateHeroPrice(el, newText){
  if(!el || _lastHeroPrice === newText){ if(el) el.textContent=newText; return; }
  _lastHeroPrice = newText;
  el.innerHTML = '';
  [...newText].forEach((ch, idx)=>{
    const span = document.createElement('span');
    span.className = 'price-digit';
    span.textContent = ch;
    if(/\d/.test(ch)){
      span.style.display='inline-block';
      span.style.animationDelay = (idx * 38)+'ms';
      span.classList.add('price-digit-anim');
    }
    el.appendChild(span);
  });
}

/* Abre la ficha si la URL trae #CODIGO */
function applyHash(){
  const h = decodeURIComponent((location.hash||'').replace(/^#/,'')).trim();
  if(!h) return;
  const item = ITEMS.find(x=>(x.code||'').toLowerCase()===h.toLowerCase());
  if(item) openDetail(item.i, true);
}

/* Compartir producto (link directo) */
function shareDetail(){
  const item = detailItem; if(!item) return;
  const url = location.origin+location.pathname+(item.code?'#'+encodeURIComponent(item.code):'');
  const text = `${item.name} — ${fmt(item.salePrice)}`;
  if(navigator.share){
    navigator.share({title:item.name, text, url}).catch(()=>{});
  }else if(navigator.clipboard){
    navigator.clipboard.writeText(url).catch(()=>fallbackShare(url));
  }else fallbackShare(url);
}
/* Task 5: Share individual product via WhatsApp with specific format */
function shareDetailWa(){
  const item = detailItem; if(!item) return;
  const code = item.code || '';
  const url = `https://tbrtoolscatalogo.vercel.app/#${encodeURIComponent(code)}`;
  const msg = `Mirá este producto: ${item.name} - ${fmt(item.salePrice)} efectivo. Pedilo acá: ${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`,'_blank','noopener');
}

function fallbackShare(url){
  const item = detailItem;
  const msg = `${item.name} — ${fmt(item.salePrice)}\n${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`,'_blank','noopener');
}

function detailStageHTML(item){
  const v = (detailPhoto===0) ? videoOf(item) : null;
  if(v) return videoTag(v, item.photos[0], 'card-img');
  return item.photos[detailPhoto]
    ? `<div class="stage-media">${photoLayers(item.photos[detailPhoto],'stage-img')}</div>`
    : `<div class="stage-media"><div class="ph"><div class="ph-glyph">${esc(item.initial)}</div><div class="ph-tag">${item.code?esc(item.code):'FOTO PRODUCTO'}</div></div></div>`;
}

function renderDetail(){
  const item = detailItem;
  // Fondo difuminado
  const img = bgImageFor(item);
  $('#detailBg').innerHTML = `
    <div class="bg-layer on">${img?`<div class="kb" style="background-image:url('${img}')"></div>`:`<div style="position:absolute;inset:0;background:radial-gradient(ellipse 80% 70% at 60% 30%,#1c1813,#090807 76%)"></div>`}</div>
    <div class="hero-scrim"></div><div class="hero-scrim-2"></div><div class="hero-vig"></div>
    <div class="detail-frost"></div>`;

  const specRows = item.specs.length
    ? item.specs.map(s=>`<div class="detail-specrow"><span class="detail-speck">${esc(s.k)}</span><span class="detail-specv">${esc(s.v)}</span></div>`).join('')
    : `<div class="detail-specrow"><span class="detail-speck">Categoría</span><span class="detail-specv">${esc(item.cat)}</span></div>`;
  const stockRow = item.stock!=null
    ? `<div class="detail-specrow"><span class="detail-speck">Stock</span><span class="detail-specv">${item.stock>0?item.stock+' u.':'Sin stock'}</span></div>` : '';

  const thumbs = item.photos.length>1
    ? `<div class="detail-thumbs">${item.photos.map((p,j)=>`<button class="dthumb ${j===detailPhoto?'cur':''}" style="background-image:url('${p}')" onclick="setDetailPhoto(${j})" aria-label="Foto ${j+1}"></button>`).join('')}</div>`
    : '';

  $('#detailGrid').innerHTML = `
    ${img?`<div class="detail-photo-bg"><span style="background-image:url('${img}')"></span></div>`:''}
    <div class="detail-media">
      <div class="detail-stage" id="detailStage">
        ${detailStageHTML(item)}
        <div class="hero-ticks detail-mticks" style="inset:14px"><span class="tick tl"></span><span class="tick tr"></span><span class="tick bl"></span><span class="tick br"></span></div>
      </div>
      ${thumbs}
    </div>
    <div class="detail-info">${item.photos[0]?`<div class="detail-info-bg" style="background-image:url('${item.photos[0]}');background-size:cover;background-position:center"></div>`:''}
      <div class="detail-cat"><span class="kicker">${esc(item.cat)}</span></div>
      <h1 class="detail-title">${esc(item.displayName||shortName(item.name))}</h1>
      <div class="detail-meta">
        ${item.brand?`<span class="chip chip-brand"><i>Marca</i>${esc(item.brand)}</span>`:''}
        <span class="chip code">${esc(item.code||'—')}</span>
        ${stockChip(item)}
        ${item.isBattery?`<span class="chip batt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/></svg> Sistema 20V</span>`:''}
      </div>
      <div class="detail-price"><span class="metal-gold">${fmt(item.salePrice)}</span><span class="save-badge">${ahorroPct()}% OFF</span></div>
      <div class="detail-pay">
        <span class="dp-ef">Efectivo / transferencia</span>
        <span class="dp-card">Tarjeta ${fmt(precioTarjeta(item.salePrice))} · ${getCuotasCant()} cuotas sin interés de ${fmt(valorCuota(item.salePrice))}</span>
      </div>
      <div class="detail-specs">${specRows}${stockRow}</div>
      ${stockBadge(item) ? `<div class="detail-stock-badge">${stockBadge(item)}</div>` : ''}
      ${item.description?`<div class="detail-desc">${esc(item.description).replace(/\n/g,'<br>')}</div>`:''}
      <div class="detail-actions">
        <div class="qty">
          <button onclick="detailQtyChange(-1)" aria-label="Menos">−</button>
          <span id="detailQty">${detailQty}</span>
          <button onclick="detailQtyChange(1)" aria-label="Más">+</button>
        </div>
        <button class="btn btn-gold" id="detailAddBtn" onclick="addToCart(${item.i},detailQty)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6h15l-1.5 9h-12L6 6Z"/><path d="M6 6 5 3H3"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>
          Agregar al pedido
        </button>
        <button class="btn btn-ghost" onclick="consultOne(${item.i})">
          <span class="wa-ic"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.76 1.53 5.31L2 22l4.93-1.6a9.86 9.86 0 0 0 5.11 1.4c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm4.49 11.93c-.25-.12-1.45-.71-1.67-.79-.22-.08-.39-.12-.55.12-.16.25-.63.79-.78.95-.14.16-.29.18-.54.06-1.45-.72-2.4-1.29-3.36-2.92-.25-.43.25-.4.72-1.33.08-.16.04-.3-.04-.43-.08-.12-.55-1.32-.75-1.81-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.41.06-.63.31-.22.25-.84.82-.84 2 0 1.18.86 2.32.98 2.48.12.16 1.68 2.57 4.07 3.5 2 .79 2.4.63 2.84.59.44-.04 1.45-.59 1.65-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.47-.28Z"/></svg></span>
          Consultar
        </button>
        <button class="btn btn-ghost btn-share" onclick="shareDetailWa()" aria-label="Compartir por WhatsApp">
          <span class="wa-ic"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.76 1.53 5.31L2 22l4.93-1.6a9.86 9.86 0 0 0 5.11 1.4c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm4.49 11.93c-.25-.12-1.45-.71-1.67-.79-.22-.08-.39-.12-.55.12-.16.25-.63.79-.78.95-.14.16-.29.18-.54.06-1.45-.72-2.4-1.29-3.36-2.92-.25-.43.25-.4.72-1.33.08-.16.04-.3-.04-.43-.08-.12-.55-1.32-.75-1.81-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.41.06-.63.31-.22.25-.84.82-.84 2 0 1.18.86 2.32.98 2.48.12.16 1.68 2.57 4.07 3.5 2 .79 2.4.63 2.84.59.44-.04 1.45-.59 1.65-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.47-.28Z"/></svg></span>
          Compartir
        </button>
      </div>
    </div>`;

  renderRelated(item);
}

function setDetailPhoto(j){
  detailPhoto=j;
  $('#detailStage').querySelector('.stage-media').outerHTML = detailStageHTML(detailItem);
  // restaurar ticks (outerHTML reemplazó solo media)
  if(!$('#detailStage .detail-mticks')){
    $('#detailStage').insertAdjacentHTML('beforeend','<div class="hero-ticks detail-mticks" style="inset:14px"><span class="tick tl"></span><span class="tick tr"></span><span class="tick bl"></span><span class="tick br"></span></div>');
  }
  $$('.dthumb').forEach((el,k)=>el.classList.toggle('cur',k===j));
}
function detailQtyChange(d){ detailQty=Math.max(1,detailQty+d); $('#detailQty').textContent=detailQty; }

function renderRelated(item){
  const rel = ITEMS.filter(x=>x.cat===item.cat && x.i!==item.i).slice(0,4);
  const pool = rel.length?rel:ITEMS.filter(x=>x.i!==item.i).slice(0,4);
  if(!pool.length){ $('#related').innerHTML=''; return; }
  $('#related').innerHTML = `
    <div class="related-head"><span class="kicker">También te puede interesar</span></div>
    <div class="related-grid">${pool.map(cardHTML).join('')}</div>`;
  // Cards dentro del panel de detalle tienen su propio scroll — el IntersectionObserver
  // del window nunca las ve, así que las hacemos visibles directamente con stagger.
  $$('#related .reveal').forEach((el,k)=>{
    setTimeout(()=>el.classList.add('card-visible'), k * 60);
  });
  syncAddButtons();
}

/* ════════════════════════════════════════════════════════════════
   CARRITO / PEDIDO
═════════════════════════════════════════════════════════════════ */
let CART = loadCart();   // [{code, qty}]
let cartOpen = false;
let cartView = 'list';        // 'list' | 'summary' | 'checkout' | 'done'
let submitting = false;
let lastOrder = null, lastVia = null;
let selectedPayment = localStorage.getItem('tbr_paymethod') || 'efectivo'; // 'efectivo' | 'cuotas'

/* ── Firebase / Firestore ── */
let db = null, FB_READY = false, rtdb = null;
function initFirebase(){
  try{
    const cfg = window.FIREBASE_CONFIG;
    const bad = v => !v || /PEGÁ/i.test(String(v));
    if(!cfg || bad(cfg.apiKey) || bad(cfg.appId)) return;        // aún sin configurar
    if(!window.firebase || !firebase.firestore) return;          // SDK no cargado
    if(!firebase.apps || !firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();
    FB_READY = true;
    if(firebase.database) rtdb = firebase.database();
  }catch(e){ console.warn('Firebase no inicializado:', e && e.message); FB_READY = false; }
}

function uuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}

/* Documento de pedido con la estructura EXACTA que consume TBR Tools Manager */
function buildOrder(cliente, tel){
  return {
    id: uuid(),
    date: new Date().toISOString(),
    cliente: cliente,
    tel: tel || '',
    cuit: '',
    status: 'cotizacion',
    origen: 'catalogo-digital',
    origen_contacto: ($('#coOrigen')?.value||''),
    sincronizado: false,
    formaPago: selectedPayment,
    cuotasCant: selectedPayment==='cuotas' ? getCuotasCant() : 0,
    recargoPct: selectedPayment==='cuotas' ? getRecargoPct() : 0,
    items: cartLines().map(({item,qty})=>({
      n: item.name,
      c: item.code || '',
      q: qty,
      p: Math.round(item.salePrice)
    }))
  };
}

function setPaymentMethod(method){
  selectedPayment = method;
  localStorage.setItem('tbr_paymethod', method);
  renderCart();
}

function loadCart(){
  try{ return JSON.parse(localStorage.getItem('tbr_cart')||'[]'); }catch{ return []; }
}
function saveCart(){ localStorage.setItem('tbr_cart', JSON.stringify(CART)); }

function cartLines(){
  // map a items vigentes por code
  return CART.map(l=>{
    const item = ITEMS.find(x=>x.code===l.code) || ITEMS.find(x=>x.name===l.name);
    return item ? {item, qty:l.qty} : null;
  }).filter(Boolean);
}
function cartQtyTotal(){ return CART.reduce((a,l)=>a+l.qty,0); }
function cartTotal(){ return cartLines().reduce((a,{item,qty})=>a+item.salePrice*qty,0); }

function addToCart(i, qty, sourceEl){
  const item = ITEMS[i]; if(!item) return;
  qty = qty||1;
  const line = CART.find(l=>l.code===item.code);
  if(line) line.qty += qty;
  else CART.push({code:item.code, name:item.name, qty});
  saveCart(); syncCartUI(); syncAddButtons();
  flashAdd(i);
  // Task 2: fly-to-cart if image source is available
  flyToCart(i, sourceEl);
}
function cartChange(code,d){
  const line = CART.find(l=>l.code===code); if(!line) return;
  line.qty += d;
  if(line.qty<=0) CART = CART.filter(l=>l.code!==code);
  saveCart(); renderCart(); syncCartUI(); syncAddButtons();
}
function cartRemove(code){ CART = CART.filter(l=>l.code!==code); saveCart(); renderCart(); syncCartUI(); syncAddButtons(); }

function flashAdd(i){
  const btn = document.querySelector(`[data-add="${i}"]`);
  if(btn){ btn.classList.add('added'); setTimeout(()=>btn.classList.remove('added'),900); }
  const detailBtn = $('#detailAddBtn');
  if(detailBtn && detailOpen){
    const orig = detailBtn.innerHTML;
    detailBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> ¡Agregado!';
    detailBtn.disabled = true;
    setTimeout(()=>{ detailBtn.innerHTML=orig; detailBtn.disabled=false; }, 1200);
  }
  const cc=$('#cartCount'); cc.style.transform='scale(0)'; requestAnimationFrame(()=>{ cc.classList.add('show'); cc.style.transform=''; });
}
/* Task 2: Fly-to-cart animation */
function flyToCart(i, sourceEl){
  const item = ITEMS[i]; if(!item) return;
  const imgUrl = item.photos[0] || null;
  if(!imgUrl) return;
  // Find source element: the card media, or add button
  let srcRect = null;
  if(sourceEl && sourceEl.getBoundingClientRect){
    srcRect = sourceEl.getBoundingClientRect();
  } else {
    const card = document.querySelector(`[data-add="${i}"]`);
    if(card){
      const media = card.closest('.card')?.querySelector('.card-media');
      srcRect = (media || card).getBoundingClientRect();
    }
  }
  if(!srcRect) return;
  // Target: cart icon button
  const cartBtn = document.querySelector('#cartCount');
  if(!cartBtn) return;
  const targetRect = cartBtn.getBoundingClientRect();
  const tx = targetRect.left + targetRect.width/2;
  const ty = targetRect.top + targetRect.height/2;
  const sx = srcRect.left + srcRect.width/2;
  const sy = srcRect.top + srcRect.height/2;
  // Create flying clone
  const fly = document.createElement('div');
  fly.className = 'fly-img';
  fly.style.cssText = `left:${sx-30}px;top:${sy-30}px;background-image:url('${imgUrl}')`;
  document.body.appendChild(fly);
  // Animate with curved trajectory using WAAPI
  const dx = tx - sx, dy = ty - sy;
  const ctrl1x = sx + dx*0.1 + 60, ctrl1y = sy - 80;
  // Use CSS keyframe via animation + JS transform
  fly.animate([
    {transform:'translate(0,0) scale(1)',opacity:1,borderRadius:'12px'},
    {transform:`translate(${dx*0.5 + 60 - 0}px,${dy*0.3 - 80}px) scale(0.85)`,opacity:1,offset:0.4},
    {transform:`translate(${dx}px,${dy}px) scale(0.2)`,opacity:0,borderRadius:'50%'}
  ],{duration:600,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'}).onfinish = ()=>{
    fly.remove();
    // bump cart icon
    const btn = cartBtn.parentElement;
    btn.classList.remove('cart-fly-bump');
    void btn.offsetWidth;
    btn.classList.add('cart-fly-bump');
    setTimeout(()=>btn.classList.remove('cart-fly-bump'), 500);
  };
}

function syncAddButtons(){
  const inCart = new Set(CART.map(l=>l.code));
  $$('[data-add]').forEach(b=>{
    const item = ITEMS[+b.dataset.add];
    b.classList.toggle('added', item && inCart.has(item.code));
  });
}
function syncCartUI(){
  const n = cartQtyTotal(), cc=$('#cartCount');
  const was = +cc.textContent||0;
  cc.textContent = n; cc.classList.toggle('show', n>0);
  if(n>was){ const b=cc.parentElement; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  // Barra de pedido fija (mobile)
  const bar=$('#orderBar');
  if(bar){
    const wasShown = bar.classList.contains('show');
    bar.classList.toggle('show', n>0);
    document.body.classList.toggle('has-orderbar', n>0);
    const t=$('#orderBarTotal'), q=$('#orderBarCount');
    if(t) t.textContent = fmt(cartTotal());
    if(q) q.textContent = `${n} ${n===1?'ítem':'ítems'}`;
    if(n>was && wasShown){
      const meta=bar.querySelector('.ob-meta');
      if(meta){ meta.classList.remove('bump'); void meta.offsetWidth; meta.classList.add('bump'); }
    }
  }
}

function openCart(){
  if(cartView==='done') cartView='list';
  if(!cartLines().length) cartView='list';
  renderCart(); cartOpen=true;
  $('#cart').classList.add('open'); $('#cartScrim').classList.add('open');
  document.body.style.overflow='hidden';
}
function closeCart(){ cartOpen=false; $('#cart').classList.remove('open'); $('#cartScrim').classList.remove('open'); if(!detailOpen) document.body.style.overflow=''; }

function goCheckout(){
  if(!cartLines().length) return;
  cartView='summary'; renderCart();
}
function goCheckoutForm(){
  cartView='checkout'; renderCart();
  setTimeout(()=>{ const el=$('#coName'); if(el) el.focus(); },120);
}
function goBackFromCheckout(){ cartView='summary'; renderCart(); }
function backToList(){ cartView='list'; renderCart(); }

function renderCart(){
  const lines = cartLines();
  if(!lines.length && cartView!=='done') cartView='list';
  $('#cartFootCount').textContent = `${cartQtyTotal()} ${cartQtyTotal()===1?'ítem':'ítems'}`;
  renderCartBody(lines);
  renderCartFoot(lines);
}

function _cartThumbHTML(item, size=64){
  if(item.photos[0]) return `<img src="${item.photos[0]}" alt="" loading="lazy" style="width:${size}px;height:${size}px;object-fit:contain;display:block">`;
  return `<div class="ph" style="width:${size}px;height:${size}px"><div class="ph-glyph">${esc(item.initial)}</div></div>`;
}

function renderCartBody(lines){
  const body = $('#cartBody');

  /* ── DONE ── */
  if(cartView==='done' && lastOrder){
    const total = lastOrder.items.reduce((a,it)=>a+it.p*it.q,0);
    const itemLines = lastOrder.items.map(it=>{
      const prod = ITEMS.find(x=>x.code===it.c)||ITEMS.find(x=>x.name===it.n);
      const thumb = prod && prod.photos && prod.photos[0] ? `<img src="${prod.photos[0]}" alt="" style="width:100%;height:100%;object-fit:contain;">` : `<div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:16px;color:rgba(226,201,126,.3)">${esc((it.n||'?').charAt(0).toUpperCase())}</div>`;
      return `<div class="od-item">
        <div class="od-item-thumb">${thumb}</div>
        <div class="od-item-info">
          <div class="od-item-name">${esc(it.n)}</div>
          <div class="od-item-qty mono">x${it.q}</div>
        </div>
        <div class="od-item-sub metal-gold">${fmt(it.p*it.q)}</div>
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="order-done">
        <div class="od-anim-wrap">
          <svg class="od-circle-svg" viewBox="0 0 72 72">
            <circle class="od-circle-bg" cx="36" cy="36" r="32" fill="none" stroke="rgba(226,201,126,.12)" stroke-width="3"/>
            <circle class="od-circle-draw" cx="36" cy="36" r="32" fill="none" stroke="url(#goldGrad)" stroke-width="3"
              stroke-dasharray="201" stroke-dashoffset="201" stroke-linecap="round"/>
            <defs><linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f3e3b0"/><stop offset="100%" stop-color="#b8975a"/>
            </linearGradient></defs>
          </svg>
          <svg class="od-check-icon" viewBox="0 0 24 24" fill="none" stroke="url(#goldGrad2)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <defs><linearGradient id="goldGrad2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f3e3b0"/><stop offset="100%" stop-color="#e2c97e"/>
            </linearGradient></defs>
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </div>
        <h4>¡Pedido enviado!</h4>
        <div class="od-order-num mono">#${esc(lastOrder.id.slice(0,8).toUpperCase())}</div>
        <p>${lastVia==='firestore'
            ? 'Recibimos tu pedido. Te contactamos a la brevedad para confirmar disponibilidad y forma de pago.'
            : 'Te abrimos WhatsApp con el detalle. Envialo y te respondemos enseguida.'}</p>
        <div class="od-items-section">
          <div class="od-items-head mono">Tu pedido incluye</div>
          ${itemLines}
        </div>
        <div class="od-total-final">
          <span class="mono">Total</span>
          <span class="metal-gold od-total-val">${fmt(total)}</span>
        </div>
        <div class="od-actions">
          ${lastVia==='firestore'?`<button class="btn od-btn-wa" onclick="sendOrderWhatsApp(lastOrder)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.76 1.53 5.31L2 22l4.93-1.6a9.86 9.86 0 0 0 5.11 1.4c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Z"/></svg>
            Ver en WhatsApp
          </button>`:''}
          <button class="btn btn-ghost od-btn-continue" onclick="closeCart()">
            Seguir comprando
          </button>
        </div>
        <canvas id="confettiCanvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10"></canvas>
      </div>`;
    // Start confetti
    setTimeout(()=>startConfetti(), 100);
    return;
  }

  /* ── SUMMARY ── */
  if(cartView==='summary'){
    const lines2 = cartLines();
    body.innerHTML = `
      <div class="co-wrap">
        <button class="co-back" onclick="backToList()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          Volver al pedido
        </button>
        <div class="sum-head">
          <span class="kicker">Tu pedido</span>
          <span class="sum-count mono">${cartQtyTotal()} ${cartQtyTotal()===1?'ítem':'ítems'}</span>
        </div>
        <div class="sum-list">
          ${lines2.map(({item,qty})=>`
            <div class="sum-item">
              <div class="sum-thumb">${item.photos[0]?`<img src="${item.photos[0]}" alt="" loading="lazy">`:`<div class="ph-glyph" style="font-size:18px">${esc(item.initial)}</div>`}</div>
              <div class="sum-info">
                <div class="sum-name">${esc(item.displayName||shortName(item.name))}</div>
                <div class="sum-qty mono">× ${qty}</div>
              </div>
              <div class="sum-sub metal-gold">${fmt(item.salePrice*qty)}</div>
            </div>`).join('')}
        </div>
        <div class="sum-divider"></div>
        <div class="sum-total-row">
          <span class="sum-total-label mono">Total estimado</span>
          <span class="sum-total-val metal-gold">${fmt(cartTotal())}</span>
        </div>
        <div class="sum-note mono">Confirmamos precio final y disponibilidad antes de cerrar la venta.</div>
      </div>`;
    return;
  }

  /* ── CHECKOUT ── */
  if(cartView==='checkout'){
    const savedName = localStorage.getItem('tbr_cliente')||'';
    const savedTel  = localStorage.getItem('tbr_tel')||'';
    body.innerHTML = `
      <div class="co-wrap">
        <button class="co-back" onclick="goBackFromCheckout()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          Volver
        </button>
        <div class="co-mini-total">
          <span class="mono">Total estimado</span>
          <span class="metal-gold" style="font-family:'Rajdhani',sans-serif;font-weight:800;font-size:22px">${fmt(cartTotal())}</span>
        </div>
        <div class="co-field co-field-float">
          <input id="coName" class="co-input" type="text" autocomplete="name" placeholder=" " value="${esc(savedName)}" oninput="validateCheckout()">
          <label class="co-label-float" for="coName">Nombre <i>· obligatorio</i></label>
          <div class="co-field-err" id="coNameErr">Este campo es obligatorio</div>
        </div>
        <div class="co-field co-field-float">
          <input id="coTel" class="co-input" type="tel" autocomplete="tel" inputmode="numeric" placeholder=" " value="${esc(savedTel)}" oninput="formatTelInput(this)">
          <label class="co-label-float" for="coTel">Teléfono / WhatsApp <i>· opcional</i></label>
        </div>
        <div class="co-field">
          <label class="co-label" for="coOrigen">¿Cómo nos conociste? <i>· opcional</i></label>
          <select id="coOrigen" class="co-input co-select">
            <option value="">— Seleccioná una opción —</option>
            <option value="Instagram">Instagram</option>
            <option value="WhatsApp">WhatsApp</option>
            <option value="Recomendación">Recomendación</option>
            <option value="Google">Google</option>
            <option value="Otro">Otro</option>
          </select>
        </div>
        ${(EMPRESA.cuotasCant>0 && EMPRESA.cuotasRecargoPct>0) ? `
        <div class="co-field">
          <label class="co-label">Forma de pago</label>
          <div class="co-pay-opts">
            <label class="co-pay-opt${selectedPayment==='efectivo'?' active':''}">
              <input type="radio" name="coPay" value="efectivo" ${selectedPayment==='efectivo'?'checked':''} onchange="setPaymentMethod('efectivo')">
              Efectivo/Transferencia — ${fmt(cartTotal())}
            </label>
            <label class="co-pay-opt${selectedPayment==='cuotas'?' active':''}">
              <input type="radio" name="coPay" value="cuotas" ${selectedPayment==='cuotas'?'checked':''} onchange="setPaymentMethod('cuotas')">
              ${getCuotasCant()}x sin interés — ${fmt(valorCuota(cartTotal()))} c/u
            </label>
          </div>
        </div>` : ''}
        <div class="co-hint mono">${FB_READY
          ? 'Tu pedido se registra y lo recibimos al instante.'
          : 'Se enviará por WhatsApp con todo el detalle.'}</div>
      </div>`;
    return;
  }

  /* ── LIST ── */
  if(!lines.length){
    body.innerHTML = `<div class="cart-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6h15l-1.5 9h-12L6 6Z"/><path d="M6 6 5 3H3"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>
      <p>Tu pedido está vacío</p>
      <span class="footer-mono">Agregá productos del catálogo</span>
    </div>`;
    return;
  }
  body.innerHTML = lines.map(({item,qty},idx)=>`
    <div class="citem" style="animation-delay:${idx*60}ms">
      <div class="citem-img">
        ${item.photos[0]
          ? `<img src="${item.photos[0]}" alt="" style="width:100%;height:100%;object-fit:contain;display:block;">`
          : `<div class="ph"><div class="ph-glyph">${esc(item.initial)}</div></div>`}
      </div>
      <div class="citem-info">
        <div class="citem-name">${esc(item.displayName||shortName(item.name))}</div>
        <div class="citem-code mono">${esc(item.code||'—')}</div>
        <div class="citem-unit-price">Unitario: <span class="metal-gold-sm">${fmt(item.salePrice)}</span></div>
        <div class="citem-foot">
          <div class="qty-sm">
            <button onclick="cartChange('${esc(item.code)}',-1)" aria-label="Menos">−</button>
            <span>${qty}</span>
            <button onclick="cartChange('${esc(item.code)}',1)" aria-label="Más">+</button>
          </div>
          <div class="citem-subtotal metal-gold">${fmt(item.salePrice*qty)}</div>
          <button class="citem-del" onclick="cartRemove('${esc(item.code)}')" aria-label="Quitar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </div>
    </div>`).join('');
}

function renderCartFoot(lines){
  const foot = $('#cartFoot');

  if(cartView==='done'){
    foot.innerHTML = `<button class="btn btn-ghost" style="width:100%" onclick="closeCart()">Seguir comprando</button>`;
    return;
  }

  if(cartView==='summary'){
    foot.innerHTML = `
      <button class="btn btn-gold" onclick="goCheckoutForm()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        Confirmar y continuar
      </button>
      <button class="co-altwa" onclick="startOrderWhatsApp()">o enviar directo por WhatsApp</button>`;
    return;
  }

  if(cartView==='checkout'){
    foot.innerHTML = `
      <div class="cart-total"><span class="l">Total estimado</span><span class="v metal-gold">${fmt(cartTotal())}</span></div>
      <button class="btn btn-gold" id="coSubmit" onclick="submitOrder()" ${submitting?'disabled':''}>
        ${submitting
          ? `<span class="spin"></span> Enviando…`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg> Enviar pedido`}
      </button>`;
    return;
  }

  if(!lines.length){
    foot.innerHTML = `<div class="cart-note" style="text-align:center;margin:0">Agregá productos para iniciar tu pedido</div>`;
    return;
  }
  foot.innerHTML = `
    <div class="cart-total"><span class="l">Total estimado</span><span class="v metal-gold">${fmt(cartTotal())}</span></div>
    <div class="cart-note">Precios en efectivo / transferencia. Confirmamos precio final y disponibilidad al recibir tu pedido.</div>
    <button class="btn btn-gold" onclick="goCheckout()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      Ver resumen del pedido
    </button>
    <button class="co-altwa" onclick="startOrderWhatsApp()">o enviar directo por WhatsApp</button>`;
}

function fmtTel(inp){
  let v = inp.value.replace(/\D/g,'');
  if(v.length>4) v = v.slice(0,4)+' '+v.slice(4);
  if(v.length>9) v = v.slice(0,9)+'-'+v.slice(9,13);
  inp.value = v;
}

function spawnConfetti(){
  const colors = ['#e2c97e','#f3e3b0','#b8975a','#ffffff'];
  for(let i=0;i<28;i++){
    const d = document.createElement('div');
    d.className = 'confetti-p';
    d.style.cssText = `left:${10+Math.random()*80}%;background:${colors[Math.floor(Math.random()*colors.length)]};animation-delay:${Math.random()*600}ms;animation-duration:${900+Math.random()*600}ms;width:${4+Math.random()*5}px;height:${4+Math.random()*5}px;border-radius:${Math.random()>0.5?'50%':'2px'}`;
    document.getElementById('cart')?.appendChild(d);
    setTimeout(()=>d.remove(), 1800);
  }
}

function validateCheckout(){
  const ok = ($('#coName')?.value||'').trim().length>0;
  const b = $('#coSubmit'); if(b) b.classList.toggle('dim', !ok);
  const errEl = $('#coNameErr'); 
  if(errEl) errEl.style.display = 'none';
}
function formatTelInput(el){
  let v = el.value.replace(/\D/g,'');
  if(v.length>4 && v.length<=6) v = v.slice(0,4)+' '+v.slice(4);
  else if(v.length>6) v = v.slice(0,4)+' '+v.slice(4,6)+'-'+v.slice(6,10);
  el.value = v;
}

/* Envía el pedido: escribe en Firestore; si no está configurado, cae a WhatsApp */
async function submitOrder(){
  if(submitting) return;
  const cliente = ($('#coName')?.value||'').trim();
  const tel     = ($('#coTel')?.value||'').trim();
  if(!cliente){ const el=$('#coName'); if(el){ el.focus(); el.classList.add('err'); const errEl=$('#coNameErr'); if(errEl) errEl.style.display='block'; } return; }
  localStorage.setItem('tbr_cliente', cliente);
  localStorage.setItem('tbr_tel', tel);

  const order = buildOrder(cliente, tel);   // se arma ANTES de vaciar el carrito

  if(!FB_READY){
    sendOrderWhatsApp(order);
    finishOrder(order, 'whatsapp');
    return;
  }

  submitting = true; renderCartFoot(cartLines());
  try{
    const coll = window.PEDIDOS_COLLECTION || 'pedidos_pendientes';
    await db.collection(coll).doc(order.id).set(order);
    submitting = false;
    finishOrder(order, 'firestore');
  }catch(e){
    console.warn('Error guardando pedido en Firestore:', e);
    submitting = false;
    sendOrderWhatsApp(order);
    finishOrder(order, 'whatsapp');
  }
}

function finishOrder(order, via){
  lastOrder = order; lastVia = via; cartView = 'done';
  CART = []; saveCart();
  renderCart(); syncCartUI(); syncAddButtons();
}

function orderToText(order){
  let msg = `*Pedido — ${EMPRESA.nombre}*\n`;
  msg += `Cliente: ${order.cliente}\n`;
  if(order.tel) msg += `Tel: ${order.tel}\n`;
  msg += `\n`;
  let total = 0;
  order.items.forEach((it,k)=>{ total += it.p*it.q;
    msg += `${k+1}. ${it.n}\n   ${it.c?it.c+' · ':''}${it.q} u. × ${fmt(it.p)} = ${fmt(it.p*it.q)}\n`;
  });
  msg += `\n*Total estimado: ${fmt(total)}*\n_Pedido #${order.id.slice(0,8).toUpperCase()} · catálogo digital_`;
  return msg;
}
function sendOrderWhatsApp(order){
  window.open(`https://wa.me/${EMPRESA.whatsapp}?text=${encodeURIComponent(orderToText(order))}`,'_blank','noopener');
}
/* Atajo: enviar por WhatsApp sin pasar por el form (usa nombre guardado si hay).
   También intenta registrar en Firestore para que llegue a la app. */
function startOrderWhatsApp(){
  const lines = cartLines();
  if(!lines.length) return;
  const order = buildOrder(localStorage.getItem('tbr_cliente')||'Cliente', localStorage.getItem('tbr_tel')||'');
  if(FB_READY && db){
    const coll = window.PEDIDOS_COLLECTION || 'pedidos_pendientes';
    db.collection(coll).doc(order.id).set(order).catch(()=>{});
  }
  sendOrderWhatsApp(order);
}
function startConfetti(){
  const canvas = document.getElementById('confettiCanvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight;
  const particles = Array.from({length:28},()=>({
    x: Math.random()*canvas.width,
    y: -10 - Math.random()*40,
    vy: 1.5+Math.random()*2.5,
    vx: (Math.random()-.5)*1.8,
    r: 3+Math.random()*4,
    alpha: 1,
    color: Math.random()>.5?'#e2c97e':'#f3e3b0',
    rot: Math.random()*360,
    rotV: (Math.random()-.5)*6
  }));
  let frame=0;
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    let alive=false;
    particles.forEach(p=>{
      p.y+=p.vy; p.x+=p.vx; p.rot+=p.rotV; p.vy+=0.04;
      if(p.y<canvas.height+20){ alive=true; }
      p.alpha = Math.max(0, 1-(p.y/(canvas.height*0.9)));
      ctx.save(); ctx.globalAlpha=p.alpha; ctx.translate(p.x,p.y);
      ctx.rotate(p.rot*Math.PI/180); ctx.fillStyle=p.color;
      ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.6); ctx.restore();
    });
    if(alive && frame<120){ frame++; requestAnimationFrame(draw); }
  }
  draw();
}
function consultOne(i){
  const c = ITEMS[i]; if(!c) return;
  const msg = `Hola! Te consulto por *${c.name}*${c.code?` (${c.code})`:''} — vi que está a ${fmt(c.salePrice)} en el catálogo.`;
  window.open(`https://wa.me/${EMPRESA.whatsapp}?text=${encodeURIComponent(msg)}`,'_blank','noopener');
}
function openWa(){
  const msg = `Hola! Te escribo por el catálogo de ${EMPRESA.nombre} 🙂`;
  window.open(`https://wa.me/${EMPRESA.whatsapp}?text=${encodeURIComponent(msg)}`,'_blank','noopener');
}

/* ── Reveal on scroll (Task 1: fade-up with IntersectionObserver, .card-visible) ── */
let io=null;
function observeReveal(){
  if(io) io.disconnect();
  io = new IntersectionObserver((es)=>{
    es.forEach(e=>{
      if(e.isIntersecting){
        // stagger delay based on position in viewport batch
        const delay = Math.min(+e.target.dataset.revealIdx||0, 8) * 0.05;
        e.target.style.transitionDelay = delay+'s';
        e.target.classList.add('card-visible');
        io.unobserve(e.target);
      }
    });
  },{threshold:.12, rootMargin:'0px 0px -40px 0px'});
  $$('.reveal:not(.card-visible)').forEach((el,k)=>{
    el.dataset.revealIdx = k;
    io.observe(el);
  });
}

/* ════════════════════════════════════════════════════════════════
   INIT
═════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════
   TASK 3: SKELETON LOADING
═════════════════════════════════════════════════════════════════ */
function skeletonCard(){
  return `<div class="skeleton-card">
    <div class="sk-media"></div>
    <div class="sk-body">
      <div class="skeleton sk-cat"></div>
      <div class="skeleton sk-name"></div>
      <div class="sk-chips"><div class="skeleton sk-chip"></div><div class="skeleton sk-chip"></div></div>
      <div class="sk-foot"><div class="skeleton sk-price"></div><div class="skeleton sk-add"></div></div>
    </div>
  </div>`;
}
function showSkeletons(){
  const heroMain = $('#heroMain');
  if(heroMain && !heroMain.innerHTML.trim()){
    const hero = document.querySelector('.hero');
    if(hero && !$('#heroSkeleton')){
      hero.insertAdjacentHTML('afterbegin',
        `<div class="skeleton-hero" id="heroSkeleton" style="position:absolute;inset:0;z-index:5;pointer-events:none">
          <div class="skeleton sk-kicker"></div>
          <div class="skeleton sk-title"></div>
          <div class="sk-specs">${[1,2,3].map(()=>`<div class="skeleton sk-spec"></div>`).join('')}</div>
          <div class="skeleton sk-price"></div>
          <div class="sk-btns"><div class="skeleton sk-btn"></div><div class="skeleton sk-btn"></div></div>
        </div>`
      );
    }
  }
  const grid = $('#grid');
  if(grid && !grid.innerHTML.trim()){
    grid.innerHTML = `<div class="skeleton-grid" style="grid-column:1/-1">${[1,2,3,4,5,6].map(skeletonCard).join('')}</div>`;
  }
}
function hideSkeletons(){
  const sk = $('#heroSkeleton'); if(sk) sk.remove();
}

function bootUI(){
  hideSkeletons();
  buildItems(); buildFeatured(); buildCats();
  applyUrlFilters();
  renderHero(true); renderGrid();
  syncCartUI(); restartHeroTimer(); initHeroSwipe();
  renderHistory();
  initPremiumCursor();
}

function setCat(name){
  activeCat=name;
  $$('#cats .cat').forEach(b=>b.classList.toggle('active', b.dataset.cat===name));
}

function initPremiumCursor(){}

document.addEventListener('click', e=>{
  if(!e.target.closest('.search-box')){
    const ac=$('#searchAC'); if(ac && !ac.hidden){ ac.innerHTML=''; ac.hidden=true; }
  }
}, {passive:true});

document.addEventListener('keydown', e=>{
  if(e.key==='Escape'){ if(cartOpen) closeCart(); else if(detailOpen) closeDetail(); }
  if(!detailOpen && !cartOpen){
    if(e.key==='ArrowRight') nextHero();
    else if(e.key==='ArrowLeft') goHero(heroIdx-1);
  }
});
window.addEventListener('scroll', ()=>{
  $('#topbar').classList.toggle('scrolled', window.scrollY>40);
}, {passive:true});
window.addEventListener('hashchange', ()=>{
  if(!location.hash && detailOpen) closeDetail();
  else if(location.hash && !detailOpen) applyHash();
});

/* ── Sincronización en tiempo real: cualquier cambio de precio, stock, foto
   o descripción hecho en TBR Tools se escribe en /tbr/catalog y /tbr/empresa
   de Realtime Database, y onValue() empuja ese cambio a todos los clientes
   conectados de inmediato (sin polling, sin recargar). ── */
let liveCatalog = null, liveEmpresa = null, firstLiveApplied = false;
function applyLiveData(){
  if(!liveCatalog) return;
  EMPRESA = mapLiveEmpresa(liveEmpresa);
  PRODUCTS = liveCatalog;
  const curCode = detailItem ? detailItem.code : null;
  if(!firstLiveApplied){
    firstLiveApplied = true;
    bootUI();
    if(!detailOpen) applyHash();
    return;
  }
  buildItems(); buildFeatured(); buildCats(); renderGrid(); syncCartUI();
  if(detailOpen && curCode){
    const updated = ITEMS.find(it=>it.code===curCode);
    if(updated){ detailItem = updated; renderDetail(); }
  }
}
function startLiveSync(){
  if(!rtdb) return false;
  rtdb.ref('tbr/catalog').on('value', snap=>{
    const products = mapLiveCatalog(snap.val());
    if(products){ liveCatalog = products; applyLiveData(); }
  });
  rtdb.ref('tbr/empresa').on('value', snap=>{
    liveEmpresa = snap.val();
    if(liveCatalog) applyLiveData();
  });
  return true;
}

(async ()=>{
  showSkeletons(); // Task 3: show skeleton immediately
  initFirebase();
  bootUI();
  applyHash();
  if(startLiveSync()) return;
  // Sin SDK de Realtime Database disponible: usar REST como respaldo
  const live = await fetchLive();
  if(live){ EMPRESA=live.empresa; PRODUCTS=live.products; bootUI(); if(!detailOpen) applyHash(); }
})();
