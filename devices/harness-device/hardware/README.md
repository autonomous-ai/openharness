# Harness device hardware

Mechanical and electrical design files for the harness-device.

## PCB (`pcb/`)

Designed in EasyEDA Pro.

| File | Contents |
|---|---|
| `ProPrj_Harness_1.75_AMOLED.epro2` | EasyEDA Pro project (schematic + PCB layout source) |
| `SCH_SCH_Harness_1.75.pdf` | Schematic export (PDF) |
| `production/Gerber_PCB_Harness/` | Gerbers + drill files for fabrication (RS-274X / Excellon) |
| `production/BOM_Harness_1.75_AMOLED_PCB_Harness_1.75.xlsx` | Bill of materials |
| `production/PickAndPlace_PCB_Harness.xlsx` | Pick-and-place (CPL) data for assembly |

Open the `.epro2` project in [EasyEDA Pro](https://pro.easyeda.com/) to edit the schematic/layout.

## 3D (`3d/`)

Each part is provided in two formats, one per subfolder:

- `3d/step/` — STEP (`.step`), parametric CAD source; import into FreeCAD, SolidWorks,
  Fusion 360, etc. to edit.
- `3d/stl/` — STL (`.stl`), mesh export ready for slicing/3D printing.

| Part | STEP | STL |
|---|---|---|
| Full assembled harness | `step/Harness_assembly.step` | `stl/Harness_assembly.stl` |
| Main enclosure housing | `step/Housing.step` | `stl/Housing.stl` |
| Iron counterweight block (keeps the device from tipping/sliding on a desk) | `step/Iron_base.step` | `stl/Iron_base.stl` |
| Clamp that holds the USB-C port PCB in place | `step/USB_clamp.step` | `stl/USB_clamp.stl` |
| Physical button cap/actuator | `step/Button.step` | `stl/Button.stl` |
