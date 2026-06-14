/* ════════════════════════════════════════════════════════════════
   TBR TOOLS · Configuración de Firebase
   ────────────────────────────────────────────────────────────────
   Estos valores los sacás de la CONSOLA DE FIREBASE:
   console.firebase.google.com  →  proyecto "tbr-tools-manager"
   ⚙ (Configuración del proyecto)  →  pestaña "General"
   →  sección "Tus apps"  →  app Web (</>)  →  "SDK setup and configuration"
   Copiá el objeto firebaseConfig y pegá apiKey / messagingSenderId / appId acá abajo.

   Ya dejé prellenados los campos que se deducen de tu proyecto actual
   (projectId, authDomain, databaseURL, storageBucket). Si tu consola
   muestra valores distintos, reemplazalos por los de la consola.

   NOTA: estas claves del SDK web NO son secretas — están pensadas para
   ir en el código del cliente. La seguridad se controla con las reglas
   de Firestore (ver REGLAS-FIRESTORE.txt).
═════════════════════════════════════════════════════════════════ */
window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCH9N-fRsuTmJYxaiUBFML8EjhLKAnXDsM",
  authDomain:        "tbr-tools-manager.firebaseapp.com",
  projectId:         "tbr-tools-manager",
  storageBucket:     "tbr-tools-manager.firebasestorage.app",
  messagingSenderId: "506964362060",
  appId:             "1:506964362060:web:d6758008fcf866297b05e9",
  measurementId:     "G-C0FZZ0WQRV",
  databaseURL:       "https://tbr-tools-manager-default-rtdb.firebaseio.com"
};

/* Colección donde se crean los pedidos del catálogo */
window.PEDIDOS_COLLECTION = "pedidos_pendientes";
