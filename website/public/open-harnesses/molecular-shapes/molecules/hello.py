"""Two authored molecules for exploring a rigid bond rotation, with editable source."""
from harness_rdkit import design

design("CCCC", "butane", conformers=10, seed=7)
design("CC(=O)OCCc1ccccc1", "phenethyl-acetate", conformers=12, seed=19)
