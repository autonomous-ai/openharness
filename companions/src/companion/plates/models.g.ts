// Generated from daemons/roster.json by daemons/tools/generate.mjs. Do not edit.
import * as tim from './tim.g.js'
import * as gnu from './gnu.g.js'
import * as lynx from './lynx.g.js'
import * as mutt from './mutt.g.js'
import * as yak from './yak.g.js'
import * as gopher from './gopher.g.js'
import * as bug from './bug.g.js'
import * as tux from './tux.g.js'
import * as auk from './auk.g.js'
import * as beastie from './beastie.g.js'

export const PLATE_MODELS = { tim, gnu, lynx, mutt, yak, gopher, bug, tux, auk, beastie }

export const PLATE_SOURCE = '8beb4ee30cb6ce610b6a61690afa0d1f32a71b821be29fcd898bb97572956401'

export const PLATE_ROSTER = {
  "rules": {
    "versions": [
      "0.1",
      "1.0",
      "2.0"
    ],
    "moods": [
      "idle",
      "work",
      "need",
      "done",
      "fail",
      "back",
      "nap",
      "boop"
    ],
    "plate": {
      "cols": {
        "portrait": 28,
        "reveal": 56
      },
      "maxRows": {
        "portrait": 12,
        "reveal": 24
      },
      "frameMs": 170,
      "frames": {
        "idle": 8,
        "other": 4
      }
    }
  },
  "daemons": [
    {
      "id": "tim",
      "traits": {
        "colours": [
          [
            "magenta",
            30,
            "#ff87ff",
            "#af5fd7"
          ],
          [
            "lilac",
            20,
            "#d7afff",
            "#8787d7"
          ],
          [
            "coral",
            18,
            "#ffafaf",
            "#d75f87"
          ],
          [
            "violet",
            14,
            "#d787ff",
            "#5f00af"
          ],
          [
            "dusk",
            12,
            "#afafff",
            "#5f5f87"
          ],
          [
            "sunset",
            6,
            "#ffd7af",
            "#d7875f"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "spots",
            22
          ],
          [
            "stripes",
            18
          ],
          [
            "freckles",
            17
          ],
          [
            "patches",
            8
          ]
        ],
        "extras": [
          [
            "glasses",
            5,
            "#e4e4e4"
          ],
          [
            "beanie",
            4,
            "#ffd75f"
          ],
          [
            "headset",
            3,
            "#87afd7"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "head": [
            0.9,
            1.12
          ],
          "arms": [
            0.85,
            1.15
          ],
          "curl": [
            0.7,
            1.45
          ],
          "eyes": [
            0.85,
            1.25
          ],
          "gap": [
            0.88,
            1.12
          ]
        },
        "flags": {
          "head": {
            "high": "big-head"
          },
          "arms": {
            "high": "long-arms"
          },
          "curl": {
            "high": "curly"
          },
          "eyes": {
            "high": "wide-eyes"
          }
        },
        "accents": [
          "#ffffd7",
          "#afffff",
          "#ffd75f",
          "#d7ffaf",
          "#ffafd7"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "gnu",
      "traits": {
        "colours": [
          [
            "savanna",
            30,
            "#ffffd7",
            "#afaf87"
          ],
          [
            "blue",
            22,
            "#d7d7ff",
            "#5f87af"
          ],
          [
            "black",
            17,
            "#d0d0d0",
            "#585858"
          ],
          [
            "tawny",
            14,
            "#ffd7af",
            "#af875f"
          ],
          [
            "dusk",
            11,
            "#ffd7ff",
            "#875f87"
          ],
          [
            "golden",
            6,
            "#ffd75f",
            "#d78700"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "brindle",
            25
          ],
          [
            "blaze",
            18
          ],
          [
            "ringed",
            13
          ],
          [
            "freckles",
            9
          ]
        ],
        "extras": [
          [
            "glasses",
            5,
            "#d7af5f"
          ],
          [
            "mortarboard",
            4,
            "#8787d7"
          ],
          [
            "bowtie",
            3,
            "#ff5f5f"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "horns": [
            0.8,
            1.2
          ],
          "curl": [
            0.7,
            1.35
          ],
          "beard": [
            0.72,
            1.28
          ],
          "brows": [
            0.75,
            1.25
          ]
        },
        "flags": {
          "horns": {
            "high": "long-horns"
          },
          "curl": {
            "high": "curly"
          },
          "beard": {
            "high": "full-beard"
          },
          "brows": {
            "high": "bushy-brows"
          }
        },
        "accents": [
          "#ffaf5f",
          "#87d7ff",
          "#d7ff87",
          "#ff87af",
          "#ffffff"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "lynx",
      "traits": {
        "colours": [
          [
            "phosphor",
            30,
            "#87ff87",
            "#00af5f"
          ],
          [
            "amber",
            20,
            "#ffd787",
            "#d78700"
          ],
          [
            "snow",
            18,
            "#eeeeee",
            "#8a8a8a"
          ],
          [
            "rufus",
            14,
            "#ffaf87",
            "#af5f5f"
          ],
          [
            "visited",
            12,
            "#d7afff",
            "#875fd7"
          ],
          [
            "hyperlink",
            6,
            "#87d7ff",
            "#005fd7"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "spots",
            24
          ],
          [
            "stripes",
            18
          ],
          [
            "socks",
            15
          ],
          [
            "barred",
            8
          ]
        ],
        "extras": [
          [
            "collar",
            5,
            "#ff5f5f"
          ],
          [
            "goggles",
            4,
            "#ffd75f"
          ],
          [
            "satchel",
            3,
            "#d7af87"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "head": [
            0.92,
            1.1
          ],
          "tufts": [
            0.7,
            1.4
          ],
          "ruff": [
            0.75,
            1.3
          ],
          "tail": [
            0.75,
            1.3
          ]
        },
        "flags": {
          "head": {
            "high": "big-head"
          },
          "tufts": {
            "high": "long-tufts"
          },
          "ruff": {
            "high": "fluffy"
          },
          "tail": {
            "high": "long-tail"
          }
        },
        "accents": [
          "#ffffd7",
          "#afffff",
          "#ffd7ff",
          "#ffaf5f",
          "#d7d7ff"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "mutt",
      "traits": {
        "colours": [
          [
            "ginger",
            30,
            "#ffaf5f",
            "#d75f00"
          ],
          [
            "wheaten",
            20,
            "#ffd7af",
            "#d7af5f"
          ],
          [
            "cocoa",
            18,
            "#af875f",
            "#875f00"
          ],
          [
            "snow",
            14,
            "#ffffff",
            "#bcbcbc"
          ],
          [
            "soot",
            12,
            "#a8a8a8",
            "#3a3a3a"
          ],
          [
            "merle",
            6,
            "#afd7ff",
            "#5f87af"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "socks",
            22
          ],
          [
            "spots",
            18
          ],
          [
            "blaze",
            15
          ],
          [
            "brindle",
            10
          ]
        ],
        "extras": [
          [
            "mailbag",
            5,
            "#87afd7"
          ],
          [
            "bandana",
            4,
            "#ff5f5f"
          ],
          [
            "letter",
            3,
            "#ffffd7"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "head": [
            0.9,
            1.12
          ],
          "flop": [
            0.8,
            1.3
          ],
          "tail": [
            0.75,
            1.25
          ],
          "scruff": [
            0.5,
            1.6
          ]
        },
        "flags": {
          "head": {
            "high": "big-head"
          },
          "flop": {
            "high": "floppy"
          },
          "tail": {
            "high": "long-tail"
          },
          "scruff": {
            "high": "scruffy"
          }
        },
        "accents": [
          "#ffffff",
          "#ffffd7",
          "#ffd7af",
          "#d7875f",
          "#585858"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "yak",
      "traits": {
        "colours": [
          [
            "russet",
            30,
            "#ffd7af",
            "#af5f5f"
          ],
          [
            "soot",
            20,
            "#bcbcbc",
            "#444444"
          ],
          [
            "bison",
            16,
            "#d7875f",
            "#5f0000"
          ],
          [
            "snow",
            14,
            "#ffffff",
            "#a8a8a8"
          ],
          [
            "frost",
            14,
            "#d7ffff",
            "#5f87af"
          ],
          [
            "golden",
            6,
            "#ffff87",
            "#d7af00"
          ]
        ],
        "marks": [
          [
            null,
            34
          ],
          [
            "blaze",
            22
          ],
          [
            "socks",
            18
          ],
          [
            "two-tone",
            16
          ],
          [
            "piebald",
            10
          ]
        ],
        "extras": [
          [
            "bell",
            5,
            "#ffd75f"
          ],
          [
            "braids",
            4,
            "#ff5f5f"
          ],
          [
            "clippers",
            3,
            "#d0d0d0"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "horns": [
            0.8,
            1.2
          ],
          "shag": [
            0.75,
            1.15
          ],
          "hump": [
            0.8,
            1.3
          ]
        },
        "flags": {
          "horns": {
            "high": "long-horns"
          },
          "shag": {
            "high": "shaggy",
            "low": "shorn"
          },
          "hump": {
            "high": "big-hump"
          }
        },
        "accents": [
          "#ffffff",
          "#ffffd7",
          "#d7d7d7",
          "#af875f",
          "#875f5f"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "gopher",
      "traits": {
        "colours": [
          [
            "prairie",
            30,
            "#d7af87",
            "#875f00"
          ],
          [
            "cinnamon",
            20,
            "#ffaf87",
            "#af5f5f"
          ],
          [
            "dune",
            18,
            "#ffffd7",
            "#d7af5f"
          ],
          [
            "silt",
            14,
            "#d7d7af",
            "#87875f"
          ],
          [
            "coal",
            12,
            "#8a8a8a",
            "#3a3a3a"
          ],
          [
            "goldy",
            6,
            "#ffd75f",
            "#d78700"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "mittens",
            22
          ],
          [
            "bib",
            18
          ],
          [
            "blaze",
            17
          ],
          [
            "lined",
            8
          ]
        ],
        "extras": [
          [
            "flower",
            5,
            "#ff87d7"
          ],
          [
            "lantern",
            4,
            "#ffaf5f"
          ],
          [
            "hardhat",
            3,
            "#ffd700"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "cheeks": [
            0.8,
            1.3
          ],
          "teeth": [
            0.75,
            1.45
          ],
          "chub": [
            0.88,
            1.16
          ],
          "ears": [
            0.8,
            1.35
          ]
        },
        "flags": {
          "cheeks": {
            "high": "stuffed"
          },
          "teeth": {
            "high": "buck-teeth"
          },
          "chub": {
            "high": "chubby"
          },
          "ears": {
            "high": "big-ears"
          }
        },
        "accents": [
          "#ffffd7",
          "#eeeeee",
          "#ffd7af",
          "#ffd787",
          "#ffd7d7"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "bug",
      "traits": {
        "colours": [
          [
            "logbook",
            30,
            "#ffffaf",
            "#87875f"
          ],
          [
            "peppered",
            20,
            "#e4e4e4",
            "#585858"
          ],
          [
            "atlas",
            18,
            "#ffaf87",
            "#875f5f"
          ],
          [
            "underwing",
            14,
            "#d7d7ff",
            "#5f5f87"
          ],
          [
            "rosy",
            12,
            "#ffafd7",
            "#d7af5f"
          ],
          [
            "luna",
            6,
            "#d7ffaf",
            "#5faf87"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "speckles",
            24
          ],
          [
            "bands",
            18
          ],
          [
            "tips",
            13
          ],
          [
            "eyespots",
            10
          ]
        ],
        "extras": [
          [
            "lamp",
            5,
            "#ffd700"
          ],
          [
            "crosstape",
            4,
            "#d7af87"
          ],
          [
            "relay",
            3,
            "#d7875f"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "span": [
            0.86,
            1.06
          ],
          "plumes": [
            0.7,
            1.35
          ],
          "fluff": [
            0.85,
            1.3
          ]
        },
        "flags": {
          "span": {
            "high": "broad-wings"
          },
          "plumes": {
            "high": "plumy"
          },
          "fluff": {
            "high": "fluffy"
          }
        },
        "accents": [
          "#ffd75f",
          "#ff875f",
          "#afd7ff",
          "#ffafd7",
          "#ffffd7"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "tux",
      "traits": {
        "colours": [
          [
            "ice",
            30,
            "#d7ffff",
            "#5f87ff"
          ],
          [
            "emperor",
            20,
            "#ffd787",
            "#5f87af"
          ],
          [
            "midnight",
            17,
            "#87afd7",
            "#0000af"
          ],
          [
            "chick",
            15,
            "#e4e4e4",
            "#8a8a8a"
          ],
          [
            "isabelline",
            12,
            "#ffffd7",
            "#af875f"
          ],
          [
            "gold",
            6,
            "#ffd75f",
            "#af5f00"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "speckles",
            22
          ],
          [
            "chinstrap",
            18
          ],
          [
            "cheeks",
            16
          ],
          [
            "crest",
            9
          ]
        ],
        "extras": [
          [
            "scarf",
            5,
            "#ff5f5f"
          ],
          [
            "herring",
            4,
            "#87d7ff"
          ],
          [
            "bowtie",
            3,
            "#ff0087"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "round": [
            0.9,
            1.1
          ],
          "flippers": [
            0.88,
            1.12
          ],
          "feet": [
            0.8,
            1.25
          ],
          "beak": [
            0.8,
            1.3
          ]
        },
        "flags": {
          "round": {
            "high": "round"
          },
          "flippers": {
            "high": "long-flippers"
          },
          "feet": {
            "high": "big-feet"
          },
          "beak": {
            "high": "big-beak"
          }
        },
        "accents": [
          "#ffd700",
          "#ffaf00",
          "#ffff87",
          "#ff875f",
          "#ffd7af"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "auk",
      "traits": {
        "colours": [
          [
            "atlantic",
            30,
            "#87ffff",
            "#0087af"
          ],
          [
            "basalt",
            20,
            "#d0d0d0",
            "#4e4e4e"
          ],
          [
            "floe",
            18,
            "#ffffff",
            "#87afd7"
          ],
          [
            "kelp",
            14,
            "#d7ffaf",
            "#5f875f"
          ],
          [
            "eggshell",
            12,
            "#ffffd7",
            "#af875f"
          ],
          [
            "aurora",
            6,
            "#afffd7",
            "#af5fd7"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "grooved",
            22
          ],
          [
            "speckles",
            18
          ],
          [
            "bridled",
            17
          ],
          [
            "winter",
            8
          ]
        ],
        "extras": [
          [
            "monocle",
            5,
            "#ffd75f"
          ],
          [
            "scroll",
            4,
            "#ffd7af"
          ],
          [
            "top-hat",
            3,
            "#bcbcbc"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "bill": [
            0.85,
            1.2
          ],
          "stout": [
            0.9,
            1.12
          ],
          "tall": [
            0.93,
            1.08
          ],
          "flipper": [
            0.8,
            1.2
          ]
        },
        "flags": {
          "bill": {
            "high": "big-bill"
          },
          "stout": {
            "high": "stout"
          },
          "tall": {
            "high": "tall"
          },
          "flipper": {
            "high": "long-flippers"
          }
        },
        "accents": [
          "#ffffff",
          "#ffffd7",
          "#afffff",
          "#ffd787",
          "#ffafaf"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    },
    {
      "id": "beastie",
      "traits": {
        "colours": [
          [
            "crimson",
            30,
            "#ff8787",
            "#d70000"
          ],
          [
            "ember",
            20,
            "#ffaf5f",
            "#d75f00"
          ],
          [
            "plum",
            16,
            "#d787ff",
            "#8700af"
          ],
          [
            "berkeley",
            14,
            "#87afff",
            "#005fd7"
          ],
          [
            "ghost",
            14,
            "#eeeeee",
            "#8a8a8a"
          ],
          [
            "zombie",
            6,
            "#afd787",
            "#5f8700"
          ]
        ],
        "marks": [
          [
            null,
            35
          ],
          [
            "freckles",
            20
          ],
          [
            "ringtail",
            18
          ],
          [
            "mask",
            15
          ],
          [
            "goatee",
            12
          ]
        ],
        "extras": [
          [
            "halo",
            5,
            "#ffd75f"
          ],
          [
            "cape",
            4,
            "#00afaf"
          ],
          [
            "fork",
            3,
            "#d0d0d0"
          ],
          [
            null,
            88,
            null
          ]
        ],
        "props": {
          "horns": [
            0.75,
            1.25
          ],
          "curl": [
            0.5,
            1.5
          ],
          "tail": [
            0.85,
            1.15
          ],
          "ears": [
            0.85,
            1.15
          ]
        },
        "flags": {
          "horns": {
            "high": "long-horns"
          },
          "curl": {
            "high": "curly-horns"
          },
          "tail": {
            "high": "long-tail"
          },
          "ears": {
            "high": "big-ears"
          }
        },
        "accents": [
          "#ffffd7",
          "#ffd787",
          "#afffff",
          "#ffd7ff",
          "#d7ffaf"
        ],
        "oddEye": 0.02,
        "fidgety": 0.3
      }
    }
  ]
}
