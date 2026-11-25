# packet-tracer · Guía interactiva de redes Cisco

Herramienta web para **diseñar una red y obtener los comandos de configuración, paso a paso, de cada equipo**.
Dibujas la topología (routers, switches, PCs, servidores, Wi-Fi, Internet), indicas las IPs y las VLANs, y la guía de
configuración se genera sola, con la explicación del **porqué** de cada comando.

🔗 **Demo:** [victor-valenzuela.github.io/packet-tracer](https://victor-valenzuela.github.io/packet-tracer/)

## Para qué sirve

Está pensada para **practicar y estudiar redes en Cisco Packet Tracer**, y para tener a mano una guía ordenada que se
adapte a *tu* topología en lugar de a un caso fijo. Nace de un proyecto anterior, `networks-lab`, que era una guía
estática para un escenario concreto.

- Cambias la topología o un dato y **toda la guía se regenera**.
- Compara esquemas sobre **la misma red**: *Router on a Stick* frente a *Collapsed Core*.
- Cada equipo trae sus comandos, el orden recomendado y un **plan de pruebas** para comprobar que todo funciona.
- Los comandos pueden generarse para **Packet Tracer** o para un **equipo real** (por ahora con pocas diferencias).

> No es un simulador. No ejecuta la red: genera la configuración y deduce los resultados esperados a partir de tus datos.

## Qué incluye

**Diseño**
- Editor visual con arrastrar y soltar (React Flow): routers 2911/1941/2811, switches L2 2960 y L3 3560/3650, Access Point,
  router Wi-Fi, PC, laptop, smartphone, servidor y nodo Internet.
- Cables entre puertos concretos, con el nombre de cada puerto y la **red** de cada enlace sobre el cable.
- Se guarda en el navegador, y se puede exportar e importar como JSON.

**Enrutamiento**
- **Router on a Stick** o **Collapsed Core (switch L3)** con un selector: los datos de ambos esquemas se conservan al cambiar.
- Rutas estáticas calculadas solas, **RIPv2** u **OSPF**.
- Salida a **Internet** con router de borde, ruta por defecto y **NAT/PAT**.

**Servicios**
- **DHCP**: pools por red, direcciones excluidas, relay (`ip helper-address`) y clientes DHCP.
- **Wi-Fi**: Access Point y router Wi-Fi con SSID y WPA2, y clientes inalámbricos.

**Seguridad (todo opcional)**
- SSH, port-security, BPDU Guard, puertos sin usar apagados.
- Administración segura: `exec-timeout`, SSH solo desde una red, `login block-for`, sin CDP ni HTTP.
- **Bloqueo entre redes** con una matriz de ACL.
- Capa 2: VLAN nativa, VLANs permitidas, DTP, DHCP snooping y DAI.

**Redundancia**
- **HSRP**, **EtherChannel** y raíz de **spanning tree** alineada con el equipo activo.

**Guía y verificación**
- Comandos por equipo, con el porqué de cada uno y botón de copiar.
- **Validación** en vivo: IPs duplicadas, redes solapadas, gateways inalcanzables, VLANs sin definir…
- **Plan de pruebas** ordenado, con el resultado esperado de cada comando.
- Exportación a `.txt`, `.md` y PDF (imprimir).

**Idiomas:** español y alemán.

## Tecnologías

| | |
|---|---|
| [Astro](https://astro.build/) 6 | Páginas estáticas y rutas por idioma |
| [React](https://react.dev/) 19 | Editor interactivo |
| [@xyflow/react](https://reactflow.dev/) 12 (React Flow) | Lienzo, nodos y cables |
| [Tailwind CSS](https://tailwindcss.com/) 4 | Estilos |
| TypeScript | Todo el código de análisis y generación |
| GitHub Pages + GitHub Actions | Publicación |

No hay servidor ni base de datos: todo ocurre en el navegador.

## Cómo funciona

```
Topología (JSON)  →  applyScheme  →  analyze  →  generate  →  guía por equipo
                          │             │            └─→ buildPlan → plan de pruebas
                          │             └─→ validación (avisos y errores)
                          └─ elige qué datos se usan según el esquema
```

La topología guarda los datos de **todos** los esquemas. `applyScheme` elige los que valen según el esquema elegido, y
el resto del código trabaja sobre ese resultado.

```
src/
├── lib/
│   ├── types.ts       modelo de datos
│   ├── catalog.ts     modelos de equipo y sus puertos
│   ├── net.ts         utilidades IPv4
│   ├── scheme.ts      Router on a Stick / Collapsed Core
│   ├── analyze.ts     validación, rutas, DHCP, NAT, HSRP, ACL…
│   ├── generate.ts    comandos de cada equipo
│   ├── verify.ts      plan de pruebas
│   ├── exporter.ts    exportación a .txt / .md
│   ├── topology.ts    operaciones sobre la topología
│   └── example.ts     topologías de ejemplo
├── components/        editor, panel de propiedades y paneles de opciones
├── i18n/              textos en español y alemán
└── pages/             rutas /es/ y /de/
```

**Añadir un modelo de equipo:** una entrada en `src/lib/catalog.ts` con su nombre y la lista de puertos.

## Desarrollo

Requiere Node.js 22.12 o superior.

```bash
npm install
npm run dev       # http://localhost:4321/packet-tracer/
npm run build     # genera ./dist
npm run preview   # sirve ./dist
```

## Publicación en GitHub Pages

El flujo `.github/workflows/deploy.yml` compila y publica en cada push a `main`. Solo hace falta, una vez, en el
repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

El sitio se sirve desde `/packet-tracer/`. Si el repositorio cambia de nombre, hay que actualizar `base` en
`astro.config.mjs`.

## Límites conocidos

- Los comandos son los estándar de IOS. No están comprobados uno a uno en cada modelo de Packet Tracer.
- Los pasos del Access Point, del router Wi-Fi y del servidor DHCP son de la **interfaz gráfica** de Packet Tracer, y sus
  nombres pueden variar un poco entre versiones.
- El destino «Equipo real» solo cambia unos pocos detalles (clave RSA de 2048 bits, storm control). No adapta los
  nombres de puertos de los modelos reales.
- Solo hay una VLAN nativa y una única área OSPF para toda la red.

## Pendiente

- Más modelos de equipo (por ejemplo, routers con más puertos).
- IPv6.
- Adaptar los comandos y los puertos a equipos reales.
