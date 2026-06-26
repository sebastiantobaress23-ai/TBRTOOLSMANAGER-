# TBR Tools Business Manager — Guía del proyecto

## Estructura
Single-file SPA: todo el código (HTML, CSS, JS) vive en `index.html`. No hay bundler ni framework.

## Stack de datos
- `DB.get(key, default)` / `DB.set(key, value)` — wrapper de localStorage
- `FB_SYNC_KEYS` — lista autoritativa de los 18 keys sincronizados con Firestore
- `render()` — re-renderiza toda la app; llamar siempre después de modificar datos

## Sistema de diseño

### Paleta CSS (`:root`)
```
--ud: #C4952A    → Gold principal (accents, borders, texto primario)
--b1: #1e1e1e    → Surface más oscura
--b2: #282828    → Surface media
--b3: #333       → Surface más clara
--ch: #e8e8e8    → Texto principal
--si: #b0b0b0    → Texto secundario
--di: #7a7a7a    → Texto deshabilitado / metadata
--mu: #666       → Texto muy tenue
--gr: #4ade80    → Verde (positivo, ganancia, stock OK)
--re: #f87171    → Rojo (error, peligro, sin stock)
--ye: #fbbf24    → Amarillo (advertencia)
--us: #2dd4bf    → Teal (precios USD, destacados)
--in: #818cf8    → Indigo (info)
```

### Jerarquía de botones — RESPETAR SIEMPRE

| Clase | Uso | Estilo |
|-------|-----|--------|
| `.btn-go` | CTA principal de formulario (Guardar, Emitir, Confirmar, Generar) | Gold sólido, ancho completo |
| `.btn-p` | Acción primaria pequeña (+ Nuevo X, + Agregar, Imprimir, Exportar) | Fondo oscuro tinte gold, borde gold, texto gold |
| `.btn-g` | Acción secundaria (Editar, Ver, Duplicar, Repetir, Filtrar) | Gris neutro transparente |
| `.btn-d` | Destructivo sin confirmar (icono X en listas) | Rojo en hover, transparente en reposo |
| `.btn-rm` | Cerrar modal (botón X del header) | Solo para `.mhdr` |

**Regla de oro:** Si el botón lanza una acción nueva importante → `.btn-p`. Si confirma/guarda un formulario → `.btn-go`. Si es secundario/auxiliar → `.btn-g`. Si destruye → `.btn-d`.

### Confirmaciones
- **NUNCA** usar `confirm()` nativo del browser
- **SIEMPRE** usar `confirm2(mensaje, callback, textoOK, claseOK)` para cualquier acción destructiva

### Modales
- Estructura: `.mol` → `.mbox` → `.mhdr` + `.mbody`
- Siempre incluir `onclick="if(event.target===this)closeXxx()"` en `.mol`
- Siempre incluir `unlockBody()` al cerrar

### Funciones de utilidad importantes
```js
fmtA(n)         → Formato ARS ($ 1.234,56)
fmtU(n)         → Formato USD (US$ 1.234,56)
fmtD(d)         → Formato fecha corta (01 ene 25)
fmtT(n)         → Formato USDT
saleRevenue(s)  → Ingresos de una venta (soporta multi-item)
saleUnits(s)    → Unidades de una venta (soporta multi-item)
saleProfit(s)   → Ganancia de una venta
uid()           → ID único
esc(str)        → Escape HTML (obligatorio en todo output dinámico)
toast(msg, ok, ms) → Notificación (ok=true verde, ok=false rojo)
confirm2(msg, cb)  → Modal de confirmación (NO usar confirm() nativo)
```

### window.open para impresión
Siempre verificar que la ventana no fue bloqueada:
```js
const w = window.open('', '_blank', 'width=900,height=700');
if (!w) { toast('El navegador bloqueó la ventana. Permití ventanas emergentes para imprimir.', false, 5000); return; }
```

## Tipos de documentos (facturas)
- `tipo: 'C'` → Factura C
- `tipo: 'NC'` → Nota de Crédito C (CbteTipo 13 en AFIP)
- `tipo: 'RM'` → Remito (NO consume numeración de Factura C)
- Campo `facturaOrigen` → nro de la factura que originó una NC
- Campo `facturaOrigenId` → id de la factura que originó una NC

## Git workflow
- Branch de desarrollo: `claude/jolly-franklin-5l0prl`
- Push: `git push origin claude/jolly-franklin-5l0prl` (force push después de rebase si es necesario)
- Merge a main: siempre squash via PR con `mcp__github__merge_pull_request`
- Vercel auto-deploya desde `main`

## Reglas de calidad — NO romper
1. Nunca dejar template literals JS con backticks dobles (``) — causa pantalla negra
2. Nunca acceder a `.toLowerCase()` sin guard `(x.nombre||'')`
3. Nunca usar `s.priceARS*(s.qty||1)` — usar `saleRevenue(s)` y `saleUnits(s)`
4. Nunca usar `confirm()` nativo — siempre `confirm2()`
5. Siempre escapar output HTML dinámico con `esc()`
6. Siempre verificar `if(!w)` después de `window.open()`
