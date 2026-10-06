// Les thèmes de Harn : un seul gabarit, des variantes de polices, de palette et d'arrondis.
// Chargé avant la feuille de style pour que la première image soit déjà au bon thème.
// Le choix est un confort propre à ce navigateur : localStorage, avec repli silencieux.
(function () {
  const FONTS = 'https://fonts.googleapis.com/css2?display=swap&';

  // Les jetons communs (thème Signal). Chaque thème ne surcharge que ce qui change.
  const BASE = {
    fonts: { sans: '"Geist"', mono: '"Geist Mono"', display: '"Geist"', figures: '"Geist Mono"', weight: 600, tracking: '-0.04em', radius: 18, button: 11 },
    families: ['Geist:wght@400;500;600;700', 'Geist+Mono:wght@400;500;600'],
    light: {
      bg: '#f4f3ef', 'bg-2': '#ecebe5', surface: '#ffffff', 'surface-2': '#f6f5f1', line: '#e4e1d9', 'line-2': '#d6d2c7',
      text: '#14161a', muted: '#62666e', faint: '#9a9da3',
      signal: '#0c9d66', violet: '#4f5ee8', amber: '#b87512', danger: '#cf3d3d', 'on-signal': '#03140c', 'on-violet': '#ffffff',
      shadow: '0 1px 2px #1416190a, 0 10px 30px -12px #1416191f',
    },
    dark: {
      bg: '#0a0c0f', 'bg-2': '#0f1216', surface: '#121519', 'surface-2': '#171b20', line: '#1f242b', 'line-2': '#2a3038',
      text: '#edeff2', muted: '#959ba5', faint: '#5f6670',
      signal: '#3ddc97', violet: '#8d9bff', amber: '#f2b046', danger: '#ff6b6b', 'on-signal': '#03140c', 'on-violet': '#0a0c0f',
      shadow: '0 1px 0 #ffffff06 inset, 0 20px 40px -20px #00000080',
    },
  };

  const THEMES = {
    deus: {
      "group": "chaud",
      "name": "Deus",
      "note": "Gris bleuté, accents Gruvbox",
      "fonts": {
        "display": "\"Rubik\"",
        "sans": "\"Rubik\"",
        "mono": "\"Ubuntu Mono\"",
        "figures": "\"Rubik\"",
        "weight": 600,
        "tracking": "-0.03em",
        "radius": 12,
        "button": 9
      },
      "families": [
        "Rubik:wght@400;500;600;700",
        "Ubuntu+Mono:wght@400;700"
      ],
      "dark": {
        "bg": "#242a32",
        "bg-2": "#1e232a",
        "surface": "#2c323b",
        "surface-2": "#343b45",
        "line": "#363d48",
        "line-2": "#444c58",
        "text": "#eaeaea",
        "muted": "#b5b8bd",
        "faint": "#7a818c",
        "signal": "#98c379",
        "violet": "#fe8019",
        "amber": "#fabd2f",
        "danger": "#fb4934"
      },
      "light": {
        "bg": "#e9ebee",
        "bg-2": "#dfe2e6",
        "surface": "#f6f7f8",
        "surface-2": "#eceef1",
        "line": "#dadde2",
        "line-2": "#c8ccd3",
        "text": "#2c323b",
        "muted": "#5c6370",
        "faint": "#8a909b",
        "signal": "#5c8f3a",
        "violet": "#b05010",
        "amber": "#b07a10",
        "danger": "#c8352a"
      }
    },
    apprentice: {
      "group": "chaud",
      "name": "Apprentice",
      "note": "Gris neutre, tons terreux",
      "fonts": {
        "display": "\"Barlow\"",
        "sans": "\"Barlow\"",
        "mono": "\"Overpass Mono\"",
        "figures": "\"Barlow\"",
        "weight": 600,
        "tracking": "-0.025em",
        "radius": 6,
        "button": 4
      },
      "families": [
        "Barlow:wght@400;500;600;700",
        "Overpass+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#1c1c1c",
        "bg-2": "#161616",
        "surface": "#262626",
        "surface-2": "#303030",
        "line": "#303030",
        "line-2": "#444444",
        "text": "#bcbcbc",
        "muted": "#9a9a9a",
        "faint": "#6c6c6c",
        "signal": "#87af87",
        "violet": "#ff8700",
        "amber": "#d7af5f",
        "danger": "#d75f5f"
      },
      "light": {
        "bg": "#e4e4dc",
        "bg-2": "#d8d8cf",
        "surface": "#f0f0ea",
        "surface-2": "#e6e6de",
        "line": "#d0d0c6",
        "line-2": "#bcbcb0",
        "text": "#262626",
        "muted": "#585858",
        "faint": "#8a8a80",
        "signal": "#5f875f",
        "violet": "#c26a00",
        "amber": "#87875f",
        "danger": "#af5f5f"
      }
    },
    jellybeans: {
      "group": "chaud",
      "name": "Jellybeans",
      "note": "Noir chaud, olive et rose",
      "fonts": {
        "display": "\"Bricolage Grotesque\"",
        "sans": "\"Hanken Grotesk\"",
        "mono": "\"Inconsolata\"",
        "figures": "\"Bricolage Grotesque\"",
        "weight": 700,
        "tracking": "-0.035em",
        "radius": 14,
        "button": 10
      },
      "families": [
        "Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700",
        "Hanken+Grotesk:wght@400;500;600;700",
        "Inconsolata:wght@400;500;600"
      ],
      "dark": {
        "bg": "#151515",
        "bg-2": "#101010",
        "surface": "#1c1c1c",
        "surface-2": "#262626",
        "line": "#2a2a2a",
        "line-2": "#3a3a3a",
        "text": "#e8e8d3",
        "muted": "#b5b5a6",
        "faint": "#888888",
        "signal": "#99ad6a",
        "violet": "#f0a0c0",
        "amber": "#fad07a",
        "danger": "#cf6a4c"
      },
      "light": {
        "bg": "#ede9df",
        "bg-2": "#e2ddd1",
        "surface": "#f8f6ef",
        "surface-2": "#efebe2",
        "line": "#dcd6c9",
        "line-2": "#c9c1b1",
        "text": "#1c1c1c",
        "muted": "#5a5a52",
        "faint": "#8d8b82",
        "signal": "#657a32",
        "violet": "#b04a78",
        "amber": "#a97a16",
        "danger": "#b0482f"
      }
    },
    miasma: {
      "group": "chaud",
      "name": "Miasma",
      "note": "Forêt d’automne, brun et or",
      "fonts": {
        "display": "\"Literata\"",
        "sans": "\"Atkinson Hyperlegible\"",
        "mono": "\"Victor Mono\"",
        "figures": "\"Literata\"",
        "weight": 600,
        "tracking": "-0.02em",
        "radius": 10,
        "button": 7
      },
      "families": [
        "Literata:opsz,wght@7..72,500;7..72,600;7..72,700",
        "Atkinson+Hyperlegible:wght@400;700",
        "Victor+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#1c1c1c",
        "bg-2": "#161616",
        "surface": "#222222",
        "surface-2": "#2b2b29",
        "line": "#2f2f2c",
        "line-2": "#3f3e39",
        "text": "#d7c483",
        "muted": "#c2c2b0",
        "faint": "#7e7a6e",
        "signal": "#78824b",
        "violet": "#bb7744",
        "amber": "#c9a554",
        "danger": "#c25a3c"
      },
      "light": {
        "bg": "#e8e1d0",
        "bg-2": "#ddd4bf",
        "surface": "#f4efe3",
        "surface-2": "#ebe4d4",
        "line": "#d6ccb6",
        "line-2": "#c4b79d",
        "text": "#2a2721",
        "muted": "#5e584c",
        "faint": "#8d8573",
        "signal": "#4f7550",
        "violet": "#9c5a2e",
        "amber": "#8c6d1f",
        "danger": "#9a3f2c"
      }
    },
    sonokai: {
      "group": "chaud",
      "name": "Sonokai",
      "note": "Gris doux, vert et orange",
      "fonts": {
        "display": "\"Red Hat Display\"",
        "sans": "\"Red Hat Text\"",
        "mono": "\"Red Hat Mono\"",
        "figures": "\"Red Hat Display\"",
        "weight": 700,
        "tracking": "-0.03em",
        "radius": 12,
        "button": 9
      },
      "families": [
        "Red+Hat+Display:wght@500;600;700",
        "Red+Hat+Text:wght@400;500;600;700",
        "Red+Hat+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#2c2e34",
        "bg-2": "#222327",
        "surface": "#33353f",
        "surface-2": "#3b3e48",
        "line": "#3b3e48",
        "line-2": "#414550",
        "text": "#e2e2e3",
        "muted": "#b4b5b9",
        "faint": "#7f8490",
        "signal": "#9ed072",
        "violet": "#f39660",
        "amber": "#e7c664",
        "danger": "#fc5d7c"
      },
      "light": {
        "bg": "#eceae6",
        "bg-2": "#e2dfda",
        "surface": "#f8f7f4",
        "surface-2": "#efede9",
        "line": "#dcd9d3",
        "line-2": "#c9c5bd",
        "text": "#2c2e34",
        "muted": "#5d606a",
        "faint": "#8b8e98",
        "signal": "#5b8a2a",
        "violet": "#c85f22",
        "amber": "#a07c0e",
        "danger": "#d03a5a"
      }
    },
    monokai: {
      "group": "chaud",
      "name": "Monokai",
      "note": "Classique · Pro Light",
      "fonts": {
        "display": "\"Archivo\"",
        "sans": "\"Archivo\"",
        "mono": "\"Fira Code\"",
        "figures": "\"Archivo\"",
        "weight": 700,
        "tracking": "-0.03em",
        "radius": 10,
        "button": 8
      },
      "families": [
        "Archivo:wght@400;500;600;700",
        "Fira+Code:wght@400;500;600"
      ],
      "dark": {
        "bg": "#1f201b",
        "bg-2": "#191a16",
        "surface": "#272822",
        "surface-2": "#31322a",
        "line": "#3e3d32",
        "line-2": "#49483e",
        "text": "#f8f8f2",
        "muted": "#cfcfc2",
        "faint": "#75715e",
        "signal": "#a6e22e",
        "violet": "#fd971f",
        "amber": "#e6db74",
        "danger": "#f92672"
      },
      "light": {
        "bg": "#f2ebe6",
        "bg-2": "#e8e0da",
        "surface": "#faf4f2",
        "surface-2": "#f0e9e5",
        "line": "#e0d7d2",
        "line-2": "#cfc4be",
        "text": "#29242a",
        "muted": "#706b6e",
        "faint": "#a59fa0",
        "signal": "#269d69",
        "violet": "#e16032",
        "amber": "#cc7a0a",
        "danger": "#e14775"
      }
    },
    panda: {
      "group": "froid",
      "name": "Panda",
      "note": "Anthracite, turquoise et rose",
      "fonts": {
        "display": "\"Fredoka\"",
        "sans": "\"Nunito\"",
        "mono": "\"Azeret Mono\"",
        "figures": "\"Fredoka\"",
        "weight": 600,
        "tracking": "-0.02em",
        "radius": 18,
        "button": 12
      },
      "families": [
        "Fredoka:wght@500;600;700",
        "Nunito:wght@400;500;600;700",
        "Azeret+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#242526",
        "bg-2": "#1e1f20",
        "surface": "#292a2b",
        "surface-2": "#31353a",
        "line": "#33363b",
        "line-2": "#43464d",
        "text": "#e6e6e6",
        "muted": "#b9bcc2",
        "faint": "#757a85",
        "signal": "#19f9d8",
        "violet": "#ff75b5",
        "amber": "#ffb86c",
        "danger": "#ff4b82"
      },
      "light": {
        "bg": "#eeeeee",
        "bg-2": "#e3e3e3",
        "surface": "#fafafa",
        "surface-2": "#f0f0f0",
        "line": "#dddddd",
        "line-2": "#cacaca",
        "text": "#292a2b",
        "muted": "#5f6168",
        "faint": "#8f939c",
        "signal": "#0f9a86",
        "violet": "#c22f7a",
        "amber": "#c97a14",
        "danger": "#e0245e"
      }
    },
    catppuccin: {
      "group": "froid",
      "name": "Catppuccin",
      "note": "Mocha · Latte",
      "fonts": {
        "display": "\"Plus Jakarta Sans\"",
        "sans": "\"Plus Jakarta Sans\"",
        "mono": "\"JetBrains Mono\"",
        "figures": "\"Plus Jakarta Sans\"",
        "weight": 700,
        "tracking": "-0.035em",
        "radius": 14,
        "button": 10
      },
      "families": [
        "Plus+Jakarta+Sans:wght@400;500;600;700",
        "JetBrains+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#181825",
        "bg-2": "#11111b",
        "surface": "#1e1e2e",
        "surface-2": "#313244",
        "line": "#313244",
        "line-2": "#45475a",
        "text": "#cdd6f4",
        "muted": "#a6adc8",
        "faint": "#7f849c",
        "signal": "#a6e3a1",
        "violet": "#cba6f7",
        "amber": "#f9e2af",
        "danger": "#f38ba8"
      },
      "light": {
        "bg": "#e6e9ef",
        "bg-2": "#dce0e8",
        "surface": "#eff1f5",
        "surface-2": "#e6e9ef",
        "line": "#ccd0da",
        "line-2": "#bcc0cc",
        "text": "#4c4f69",
        "muted": "#6c6f85",
        "faint": "#8c8fa1",
        "signal": "#40a02b",
        "violet": "#8839ef",
        "amber": "#df8e1d",
        "danger": "#d20f39"
      }
    },
    rosepine: {
      "group": "chaud",
      "name": "Rosé Pine",
      "note": "Main · Dawn",
      "fonts": {
        "display": "\"Lexend\"",
        "sans": "\"Lexend\"",
        "mono": "\"Fira Code\"",
        "figures": "\"Lexend\"",
        "weight": 600,
        "tracking": "-0.03em",
        "radius": 16,
        "button": 11
      },
      "families": [
        "Lexend:wght@400;500;600;700",
        "Fira+Code:wght@400;500;600"
      ],
      "dark": {
        "bg": "#191724",
        "bg-2": "#15131f",
        "surface": "#1f1d2e",
        "surface-2": "#26233a",
        "line": "#26233a",
        "line-2": "#403d52",
        "text": "#e0def4",
        "muted": "#908caa",
        "faint": "#6e6a86",
        "signal": "#9ccfd8",
        "violet": "#c4a7e7",
        "amber": "#f6c177",
        "danger": "#eb6f92"
      },
      "light": {
        "bg": "#faf4ed",
        "bg-2": "#f2e9e1",
        "surface": "#fffaf3",
        "surface-2": "#f4ede8",
        "line": "#dfdad9",
        "line-2": "#cecacd",
        "text": "#575279",
        "muted": "#797593",
        "faint": "#9893a5",
        "signal": "#56949f",
        "violet": "#907aa9",
        "amber": "#ea9d34",
        "danger": "#b4637a"
      }
    },
    everforest: {
      "group": "chaud",
      "name": "Everforest",
      "note": "Forêt douce, très reposant",
      "fonts": {
        "display": "\"Work Sans\"",
        "sans": "\"Work Sans\"",
        "mono": "\"Red Hat Mono\"",
        "figures": "\"Work Sans\"",
        "weight": 600,
        "tracking": "-0.03em",
        "radius": 12,
        "button": 9
      },
      "families": [
        "Work+Sans:wght@400;500;600;700",
        "Red+Hat+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#2d353b",
        "bg-2": "#232a2e",
        "surface": "#343f44",
        "surface-2": "#3d484d",
        "line": "#3d484d",
        "line-2": "#475258",
        "text": "#d3c6aa",
        "muted": "#9da9a0",
        "faint": "#859289",
        "signal": "#a7c080",
        "violet": "#7fbbb3",
        "amber": "#dbbc7f",
        "danger": "#e67e80"
      },
      "light": {
        "bg": "#f4f0d9",
        "bg-2": "#efebd4",
        "surface": "#fdf6e3",
        "surface-2": "#f4f0d9",
        "line": "#e6e2cc",
        "line-2": "#e0dcc7",
        "text": "#5c6a72",
        "muted": "#829181",
        "faint": "#a6b0a0",
        "signal": "#8da101",
        "violet": "#3a94c5",
        "amber": "#dfa000",
        "danger": "#f85552"
      }
    },
    gruvbox: {
      "group": "chaud",
      "name": "Gruvbox",
      "note": "Rétro, chaud",
      "fonts": {
        "display": "\"IBM Plex Sans\"",
        "sans": "\"IBM Plex Sans\"",
        "mono": "\"IBM Plex Mono\"",
        "figures": "\"IBM Plex Mono\"",
        "weight": 600,
        "tracking": "-0.025em",
        "radius": 8,
        "button": 6
      },
      "families": [
        "IBM+Plex+Sans:wght@400;500;600;700",
        "IBM+Plex+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#282828",
        "bg-2": "#1d2021",
        "surface": "#32302f",
        "surface-2": "#3c3836",
        "line": "#3c3836",
        "line-2": "#504945",
        "text": "#ebdbb2",
        "muted": "#bdae93",
        "faint": "#928374",
        "signal": "#8ec07c",
        "violet": "#83a598",
        "amber": "#fabd2f",
        "danger": "#fb4934"
      },
      "light": {
        "bg": "#f2e5bc",
        "bg-2": "#ebdbb2",
        "surface": "#fbf1c7",
        "surface-2": "#f2e5bc",
        "line": "#ebdbb2",
        "line-2": "#d5c4a1",
        "text": "#3c3836",
        "muted": "#665c54",
        "faint": "#928374",
        "signal": "#427b58",
        "violet": "#076678",
        "amber": "#b57614",
        "danger": "#9d0006"
      }
    },
    nord: {
      "group": "froid",
      "name": "Nord",
      "note": "Polar Night · Snow Storm",
      "fonts": {
        "display": "\"Inter\"",
        "sans": "\"Inter\"",
        "mono": "\"JetBrains Mono\"",
        "figures": "\"Inter\"",
        "weight": 700,
        "tracking": "-0.035em",
        "radius": 10,
        "button": 8
      },
      "families": [
        "Inter:wght@400;500;600;700",
        "JetBrains+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#2e3440",
        "bg-2": "#292e39",
        "surface": "#3b4252",
        "surface-2": "#434c5e",
        "line": "#434c5e",
        "line-2": "#4c566a",
        "text": "#eceff4",
        "muted": "#c0c8d6",
        "faint": "#8a96ad",
        "signal": "#a3be8c",
        "violet": "#88c0d0",
        "amber": "#ebcb8b",
        "danger": "#bf616a"
      },
      "light": {
        "bg": "#e5e9f0",
        "bg-2": "#d8dee9",
        "surface": "#eceff4",
        "surface-2": "#e5e9f0",
        "line": "#d8dee9",
        "line-2": "#c2cad8",
        "text": "#2e3440",
        "muted": "#4c566a",
        "faint": "#7b88a1",
        "signal": "#a3be8c",
        "violet": "#5e81ac",
        "amber": "#d08770",
        "danger": "#bf616a"
      }
    },
    tokyonight: {
      "group": "froid",
      "name": "Tokyo Night",
      "note": "Night · Day",
      "fonts": {
        "display": "\"Onest\"",
        "sans": "\"Onest\"",
        "mono": "\"Martian Mono\"",
        "figures": "\"Onest\"",
        "weight": 700,
        "tracking": "-0.035em",
        "radius": 14,
        "button": 10
      },
      "families": [
        "Onest:wght@400;500;600;700",
        "Martian+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#1a1b26",
        "bg-2": "#16161e",
        "surface": "#1f2335",
        "surface-2": "#292e42",
        "line": "#292e42",
        "line-2": "#3b4261",
        "text": "#c0caf5",
        "muted": "#a9b1d6",
        "faint": "#737aa2",
        "signal": "#9ece6a",
        "violet": "#7aa2f7",
        "amber": "#e0af68",
        "danger": "#f7768e"
      },
      "light": {
        "bg": "#e1e2e7",
        "bg-2": "#d0d5e3",
        "surface": "#e9e9ed",
        "surface-2": "#e1e2e7",
        "line": "#c4c8da",
        "line-2": "#a8aecb",
        "text": "#3760bf",
        "muted": "#6172b0",
        "faint": "#848cb5",
        "signal": "#587539",
        "violet": "#2e7de9",
        "amber": "#8c6c3e",
        "danger": "#f52a65"
      }
    },
    kanagawa: {
      "group": "chaud",
      "name": "Kanagawa",
      "note": "Wave · Lotus, estampe japonaise",
      "fonts": {
        "display": "\"Shippori Mincho\"",
        "sans": "\"Zen Kaku Gothic New\"",
        "mono": "\"Fira Code\"",
        "figures": "\"Shippori Mincho\"",
        "weight": 700,
        "tracking": "-0.02em",
        "radius": 12,
        "button": 8
      },
      "families": [
        "Shippori+Mincho:wght@500;600;700",
        "Zen+Kaku+Gothic+New:wght@400;500;700",
        "Fira+Code:wght@400;500;600"
      ],
      "dark": {
        "bg": "#1f1f28",
        "bg-2": "#16161d",
        "surface": "#2a2a37",
        "surface-2": "#363646",
        "line": "#363646",
        "line-2": "#54546d",
        "text": "#dcd7ba",
        "muted": "#c8c093",
        "faint": "#727169",
        "signal": "#98bb6c",
        "violet": "#7e9cd8",
        "amber": "#e6c384",
        "danger": "#e46876"
      },
      "light": {
        "bg": "#e5ddb0",
        "bg-2": "#dcd5ac",
        "surface": "#f2ecbc",
        "surface-2": "#e7dba0",
        "line": "#dcd5ac",
        "line-2": "#cdc69a",
        "text": "#545464",
        "muted": "#716e61",
        "faint": "#8a8980",
        "signal": "#6f894e",
        "violet": "#4d699b",
        "amber": "#cc6d00",
        "danger": "#c84053"
      }
    },
    one: {
      "group": "froid",
      "name": "One",
      "note": "One Dark · One Light",
      "fonts": {
        "display": "\"Albert Sans\"",
        "sans": "\"Albert Sans\"",
        "mono": "\"Roboto Mono\"",
        "figures": "\"Albert Sans\"",
        "weight": 700,
        "tracking": "-0.035em",
        "radius": 10,
        "button": 8
      },
      "families": [
        "Albert+Sans:wght@400;500;600;700",
        "Roboto+Mono:wght@400;500;600"
      ],
      "dark": {
        "bg": "#21252b",
        "bg-2": "#1b1f24",
        "surface": "#282c34",
        "surface-2": "#2f343e",
        "line": "#333842",
        "line-2": "#3e4451",
        "text": "#abb2bf",
        "muted": "#9097a3",
        "faint": "#5c6370",
        "signal": "#98c379",
        "violet": "#61afef",
        "amber": "#e5c07b",
        "danger": "#e06c75"
      },
      "light": {
        "bg": "#f0f0f1",
        "bg-2": "#e5e5e6",
        "surface": "#fafafa",
        "surface-2": "#f0f0f1",
        "line": "#e0e0e2",
        "line-2": "#d0d0d3",
        "text": "#383a42",
        "muted": "#696c77",
        "faint": "#a0a1a7",
        "signal": "#50a14f",
        "violet": "#4078f2",
        "amber": "#c18401",
        "danger": "#e45649"
      }
    },
    solarized: {
      "group": "froid",
      "name": "Solarized",
      "note": "Le classique à faible contraste",
      "fonts": {
        "display": "\"Source Serif 4\"",
        "sans": "\"Source Sans 3\"",
        "mono": "\"Source Code Pro\"",
        "figures": "\"Source Serif 4\"",
        "weight": 600,
        "tracking": "-0.02em",
        "radius": 8,
        "button": 6
      },
      "families": [
        "Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700",
        "Source+Sans+3:wght@400;500;600;700",
        "Source+Code+Pro:wght@400;500;600"
      ],
      "dark": {
        "bg": "#002b36",
        "bg-2": "#00212b",
        "surface": "#073642",
        "surface-2": "#0b3f4c",
        "line": "#124754",
        "line-2": "#1e5563",
        "text": "#93a1a1",
        "muted": "#839496",
        "faint": "#657b83",
        "signal": "#859900",
        "violet": "#268bd2",
        "amber": "#b58900",
        "danger": "#dc322f"
      },
      "light": {
        "bg": "#eee8d5",
        "bg-2": "#e4dcc4",
        "surface": "#fdf6e3",
        "surface-2": "#f4eedb",
        "line": "#e4dcc4",
        "line-2": "#d6ccb0",
        "text": "#586e75",
        "muted": "#657b83",
        "faint": "#93a1a1",
        "signal": "#859900",
        "violet": "#268bd2",
        "amber": "#b58900",
        "danger": "#dc322f"
      }
    },
    dracula: {
      "group": "froid",
      "name": "Dracula",
      "note": "Dracula · Alucard",
      "fonts": {
        "display": "\"Fira Sans\"",
        "sans": "\"Fira Sans\"",
        "mono": "\"Fira Code\"",
        "figures": "\"Fira Sans\"",
        "weight": 700,
        "tracking": "-0.03em",
        "radius": 12,
        "button": 9
      },
      "families": [
        "Fira+Sans:wght@400;500;600;700",
        "Fira+Code:wght@400;500;600"
      ],
      "dark": {
        "bg": "#21222c",
        "bg-2": "#191a21",
        "surface": "#282a36",
        "surface-2": "#343746",
        "line": "#343746",
        "line-2": "#44475a",
        "text": "#f8f8f2",
        "muted": "#bfc1cc",
        "faint": "#6272a4",
        "signal": "#50fa7b",
        "violet": "#bd93f9",
        "amber": "#f1fa8c",
        "danger": "#ff5555"
      },
      "light": {
        "bg": "#f4efdb",
        "bg-2": "#ebe5cf",
        "surface": "#fffbeb",
        "surface-2": "#f5f0de",
        "line": "#e6e0c8",
        "line-2": "#d5ceb3",
        "text": "#1f1f1f",
        "muted": "#6c664b",
        "faint": "#8f8a73",
        "signal": "#14710a",
        "violet": "#644ac9",
        "amber": "#846e15",
        "danger": "#cb3a2a"
      }
    },
    signal: { name: 'Signal', note: 'Net et technique', group: 'expressif', ...BASE },
    atelier: {
      group: 'expressif',
      name: 'Atelier',
      note: 'Serif chaleureuse, terre cuite',
      fonts: { sans: '"Instrument Sans"', mono: '"JetBrains Mono"', display: '"Fraunces"', figures: '"Fraunces"', weight: 560, tracking: '-0.02em', radius: 14, button: 10 },
      families: ['Fraunces:opsz,wght@9..144,400;9..144,560;9..144,700', 'Instrument+Sans:wght@400;500;600;700', 'JetBrains+Mono:wght@400;500;600'],
      light: {
        bg: '#f3eee6', 'bg-2': '#ebe4d8', surface: '#fbf8f3', 'surface-2': '#f1ebe1', line: '#e2d8c8', 'line-2': '#d3c6b2',
        text: '#2a211b', muted: '#6f6255', faint: '#a39684', signal: '#c4532d', violet: '#2f6f68', amber: '#a8720f', 'on-signal': '#fff8f2', 'on-violet': '#ffffff',
      },
      dark: {
        bg: '#15110e', 'bg-2': '#1b1612', surface: '#211b16', 'surface-2': '#2a221c', line: '#352b23', 'line-2': '#45392e',
        text: '#f2e9dd', muted: '#b3a493', faint: '#7a6c5d', signal: '#f08a5d', violet: '#6fc2b5', amber: '#e8b04f', 'on-signal': '#1c0d05', 'on-violet': '#0c1a18',
      },
    },
    terminal: {
      group: 'expressif',
      name: 'Terminal',
      note: 'Tout en mono, ambre phosphore',
      fonts: { sans: '"JetBrains Mono"', mono: '"JetBrains Mono"', display: '"JetBrains Mono"', figures: '"JetBrains Mono"', weight: 700, tracking: '-0.05em', radius: 6, button: 4 },
      families: ['JetBrains+Mono:wght@400;500;600;700;800'],
      light: {
        bg: '#f4f1e6', 'bg-2': '#ebe6d5', surface: '#fbf9f1', 'surface-2': '#f1ecdc', line: '#ddd5bd', 'line-2': '#cbc0a1',
        text: '#1d1a12', muted: '#625a45', faint: '#9a917a', signal: '#9a6200', violet: '#00708f', amber: '#b3460b', 'on-signal': '#fffaf0', 'on-violet': '#ffffff',
      },
      dark: {
        bg: '#0a0907', 'bg-2': '#0e0c09', surface: '#13110c', 'surface-2': '#1a1710', line: '#2a2516', 'line-2': '#3a331f',
        text: '#f4e8c8', muted: '#b7a77d', faint: '#75694d', signal: '#ffb000', violet: '#4fd6ff', amber: '#ff7a3d', 'on-signal': '#1a1200', 'on-violet': '#001a22',
        shadow: '0 0 0 1px #00000000',
      },
    },
    nordique: {
      group: 'expressif',
      name: 'Glacier',
      note: 'Grotesque géométrique, bleu glacier',
      fonts: { sans: '"Manrope"', mono: '"IBM Plex Mono"', display: '"Space Grotesk"', figures: '"Space Grotesk"', weight: 600, tracking: '-0.035em', radius: 22, button: 12 },
      families: ['Space+Grotesk:wght@500;600;700', 'Manrope:wght@400;500;600;700', 'IBM+Plex+Mono:wght@400;500;600'],
      light: {
        bg: '#eef2f5', 'bg-2': '#e5eaef', surface: '#ffffff', 'surface-2': '#f3f6f9', line: '#dbe2e9', 'line-2': '#c8d2dc',
        text: '#0f1a24', muted: '#5a6976', faint: '#93a1ad', signal: '#0874b0', violet: '#6a4fd8', amber: '#b8760d', 'on-signal': '#ffffff', 'on-violet': '#ffffff',
      },
      dark: {
        bg: '#0a1017', 'bg-2': '#0e161f', surface: '#121c26', 'surface-2': '#18232f', line: '#1f2c39', 'line-2': '#2b3a4a',
        text: '#e8f0f6', muted: '#8fa1b1', faint: '#5b6b7a', signal: '#5ec8ff', violet: '#a594ff', amber: '#f2b046', 'on-signal': '#03121d', 'on-violet': '#0d0a1f',
      },
    },
    neon: {
      group: 'expressif',
      name: 'Néon',
      note: 'Affiche ronde, rose et cyan',
      fonts: { sans: '"DM Sans"', mono: '"DM Mono"', display: '"Unbounded"', figures: '"Unbounded"', weight: 600, tracking: '-0.03em', radius: 24, button: 14 },
      families: ['Unbounded:wght@500;600;700', 'DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700', 'DM+Mono:wght@400;500'],
      light: {
        bg: '#fbf4fb', 'bg-2': '#f4e9f5', surface: '#ffffff', 'surface-2': '#f8eff9', line: '#ecdcef', 'line-2': '#dcc6e1',
        text: '#22102c', muted: '#6c5677', faint: '#a491ad', signal: '#d81b7a', violet: '#0089ad', amber: '#b57400', 'on-signal': '#ffffff', 'on-violet': '#ffffff',
      },
      dark: {
        bg: '#0c0613', 'bg-2': '#110a1b', surface: '#170d24', 'surface-2': '#1f132f', line: '#2c1d40', 'line-2': '#3b2955',
        text: '#f6eefe', muted: '#ad9cc4', faint: '#6e5d86', signal: '#ff4fa3', violet: '#45e6ff', amber: '#ffcc4d', 'on-signal': '#24000f', 'on-violet': '#00161c',
      },
    },
    papier: {
      group: 'expressif',
      name: 'Papier',
      note: 'Éditorial, encre et vert forêt',
      fonts: { sans: '"Public Sans"', mono: '"IBM Plex Mono"', display: '"Newsreader"', figures: '"Newsreader"', weight: 600, tracking: '-0.025em', radius: 10, button: 8 },
      families: ['Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700', 'Public+Sans:wght@400;500;600;700', 'IBM+Plex+Mono:wght@400;500;600'],
      light: {
        bg: '#f7f5f0', 'bg-2': '#efece4', surface: '#fffefb', 'surface-2': '#f5f2ea', line: '#e6e1d5', 'line-2': '#d6cfbf',
        text: '#111111', muted: '#5c5a55', faint: '#9b978d', signal: '#1f6b4f', violet: '#8b2c2c', amber: '#a5650d', 'on-signal': '#ffffff', 'on-violet': '#ffffff',
        shadow: '0 1px 0 #11111108',
      },
      dark: {
        bg: '#121211', 'bg-2': '#171716', surface: '#1c1c1a', 'surface-2': '#232320', line: '#2e2d2a', 'line-2': '#3c3b36',
        text: '#efece6', muted: '#a8a59c', faint: '#6c6a63', signal: '#6fcf9f', violet: '#e58b8b', amber: '#e3ad55', 'on-signal': '#06150e', 'on-violet': '#1d0808',
        shadow: '0 1px 0 #ffffff05',
      },
    },
  };

  const FALLBACK = { sans: 'system-ui, "Segoe UI", sans-serif', mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace' };
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  // Les préférences (thème, mode, taille du texte) vivent dans un cookie d'un an : elles
  // survivent aux mises à jour de Harn et ne dépendent pas du stockage du navigateur.
  const COOKIE = 'harn_prefs';
  const SCALES = [0.85, 0.92, 1, 1.1, 1.2, 1.32, 1.45];
  function readPrefs() {
    try {
      const raw = document.cookie.split('; ').find((part) => part.startsWith(`${COOKIE}=`));
      if (raw) return JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
    } catch { /* cookie illisible : valeurs par défaut */ }
    try { return { skin: localStorage.getItem('harn.skin'), mode: localStorage.getItem('harn.mode') }; } catch { return {}; }
  }
  function writePrefs() {
    const value = encodeURIComponent(JSON.stringify({ skin, mode, scale }));
    document.cookie = `${COOKIE}=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }
  const saved = readPrefs();
  let skin = THEMES[saved.skin] ? saved.skin : 'sonokai';
  let mode = ['auto', 'light', 'dark'].includes(saved.mode) ? saved.mode : 'auto';
  let scale = SCALES.includes(Number(saved.scale)) ? Number(saved.scale) : 1;

  function loadFonts(id) {
    if (document.getElementById(`fonts-${id}`)) return;
    const link = document.createElement('link');
    link.id = `fonts-${id}`;
    link.rel = 'stylesheet';
    link.href = FONTS + THEMES[id].families.map((family) => `family=${family}`).join('&');
    document.head.appendChild(link);
  }

  // ── Contraste ─────────────────────────────────────────────
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
  const lum = (hex) => {
    const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => { const x = rgb(a); const y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  // Une couleur écrite en texte doit tenir 4,5:1 sur les cartes : sinon on la rapproche
  // progressivement de la couleur du texte (plus foncée en clair, plus claire en sombre).
  function legible(color, surface, toward, min = 4.5) {
    let c = color;
    for (let i = 0; i < 24 && contrast(c, surface) < min; i += 1) c = mix(c, toward, 0.08);
    const extreme = lum(surface) > 0.5 ? '#000000' : '#ffffff';
    for (let i = 0; i < 24 && contrast(c, surface) < min; i += 1) c = mix(c, extreme, 0.08);
    return c;
  }
  // Le texte posé sur un aplat d'accent : la teinte, claire ou foncée, la plus lisible.
  function onColor(fill, palette, resolved, preferred) {
    if (preferred && contrast(fill, preferred) >= 4.5) return preferred;
    const dark = resolved === 'dark' ? palette.bg : palette.text;
    const candidates = [preferred, dark, '#ffffff', '#111111'].filter(Boolean);
    return candidates.sort((a, b) => contrast(fill, b) - contrast(fill, a))[0];
  }

  // Les couleurs dérivées (fonds teintés, halos) suivent l'accent du thème.
  function tokens(id, resolved) {
    const theme = THEMES[id];
    const palette = { ...BASE[resolved], ...theme[resolved] };
    palette['on-signal'] = onColor(palette.signal, palette, resolved, theme[resolved]?.['on-signal']);
    palette['on-violet'] = onColor(palette.violet, palette, resolved, theme[resolved]?.['on-violet']);
    palette.danger = legible(palette.danger, palette.surface, palette.text);
    const alpha = resolved === 'dark' ? ['26', '12', '1f', '1c'] : ['24', '12', '1f', '1c'];
    return {
      ...palette,
      'signal-2': palette.signal + alpha[0],
      'signal-glow': palette.signal + alpha[1],
      'violet-2': palette.violet + alpha[2],
      'amber-2': palette.amber + alpha[3],
      // L'encre sert aux textes et aux traits : par défaut la couleur elle-même ; les thèmes
      // pastel en donnent une version plus soutenue, lisible sur fond clair.
      'signal-ink': legible(palette['signal-ink'] ?? palette.signal, palette.surface, palette.text),
      'violet-ink': legible(palette['violet-ink'] ?? palette.violet, palette.surface, palette.text),
      'amber-ink': legible(palette['amber-ink'] ?? palette.amber, palette.surface, palette.text),
    };
  }

  function apply(nextSkin = skin, nextMode = mode) {
    skin = THEMES[nextSkin] ? nextSkin : 'sonokai';
    mode = ['auto', 'light', 'dark'].includes(nextMode) ? nextMode : 'auto';
    const resolved = mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode;
    const theme = THEMES[skin];
    const fonts = { ...BASE.fonts, ...theme.fonts };
    for (const [key, value] of Object.entries(tokens(skin, resolved))) root.style.setProperty(`--${key}`, value);
    root.style.setProperty('--sans', `${fonts.sans}, ${FALLBACK.sans}`);
    root.style.setProperty('--mono', `${fonts.mono}, ${FALLBACK.mono}`);
    root.style.setProperty('--display', `${fonts.display}, ${FALLBACK.sans}`);
    root.style.setProperty('--figures', `${fonts.figures}, ${FALLBACK.mono}`);
    root.style.setProperty('--display-weight', String(fonts.weight));
    root.style.setProperty('--tracking', fonts.tracking);
    root.style.setProperty('--radius', `${fonts.radius}px`);
    root.style.setProperty('--r-btn', `${fonts.button}px`);
    root.style.colorScheme = resolved;
    root.style.setProperty('--fs', String(scale));
    root.dataset.skin = skin;
    root.dataset.resolved = resolved;
    loadFonts(skin);
    writePrefs();
    window.dispatchEvent(new CustomEvent('harn:theme', { detail: { skin, mode, resolved } }));
  }

  media.addEventListener('change', () => { if (mode === 'auto') apply(); });

  // Clair → sombre → auto (suit Windows) → clair.
  function cycleMode() {
    const resolved = root.dataset.resolved;
    const next = mode === 'auto' ? (resolved === 'dark' ? 'light' : 'dark') : mode === 'light' ? 'dark' : 'auto';
    apply(skin, next);
  }
  function setScale(step) {
    const index = SCALES.indexOf(scale);
    scale = step === 0 ? 1 : SCALES[Math.min(SCALES.length - 1, Math.max(0, index + step))];
    apply();
  }

  window.HarnThemes = {
    cycleMode,
    setScale,
    get scale() { return scale; },
    get canGrow() { return scale < SCALES.at(-1); },
    get canShrink() { return scale > SCALES[0]; },
    get resolved() { return root.dataset.resolved; },
    THEMES,
    apply,
    preview: (id) => tokens(id, root.dataset.resolved ?? 'dark'),
    loadAllFonts: () => Object.keys(THEMES).forEach(loadFonts),
    get skin() { return skin; },
    get mode() { return mode; },
  };
  apply();
})();
