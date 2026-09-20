"""Recompute the delivered primary OLS analysis using independent Python libraries.

Run in the delivery directory. This does not infer experimental validity from a model fit.
"""
import json
from pathlib import Path
import numpy as np
import scipy.stats as stats
import statsmodels.api as sm

root = Path(__file__).resolve().parent
analysis = json.loads((root / "analysis.json").read_text())
if not analysis["ok"]:
    raise SystemExit("No estimable primary model: " + analysis["issue"])
x = np.asarray(analysis["matrix"]["X"], dtype=float)
y = np.asarray(analysis["matrix"]["y"], dtype=float)
result = sm.OLS(y, x, missing="raise", hasconst=True).fit()
alpha = 1 - analysis["model"]["confidence"]
influence = result.get_influence()
report = {
    "method": "statsmodels OLS, exact delivered design matrix; conventional covariance",
    "run_ids": analysis["matrix"]["runIds"],
    "n": int(result.nobs), "df": int(result.df_resid),
    "coefficients": result.params.tolist(), "se": result.bse.tolist(),
    "intervals": result.conf_int(alpha=alpha).tolist(),
    "covariance": result.cov_params().tolist(),
    "rmse": float(np.sqrt(result.mse_resid)),
    "fitted": result.fittedvalues.tolist(), "residuals": result.resid.tolist(),
    "leverage": influence.hat_matrix_diag.tolist(),
    "studentized": influence.resid_studentized_internal.tolist(),
    "cook": influence.cooks_distance[0].tolist(),
    "critical": float(stats.t.ppf(1 - alpha / 2, result.df_resid)),
}
np.testing.assert_allclose(result.params, analysis["beta"], rtol=1e-8, atol=1e-8)
np.testing.assert_allclose(result.cov_params(), analysis["covariance"], rtol=1e-8, atol=1e-8)
np.testing.assert_allclose(result.fittedvalues, [r["fitted"] for r in analysis["residuals"]], rtol=1e-8, atol=1e-8)
np.testing.assert_allclose(influence.hat_matrix_diag, [r["leverage"] for r in analysis["residuals"]], rtol=1e-8, atol=1e-8)
if analysis["inferential"]:
    np.testing.assert_allclose(result.conf_int(alpha=alpha), [c["ci"] for c in analysis["coefficients"]], rtol=1e-7, atol=1e-7)
    np.testing.assert_allclose(influence.cooks_distance[0], [r["cook"] for r in analysis["residuals"]], rtol=1e-7, atol=1e-7)

project = json.loads((root / "project.signal.json").read_text())
confirmation_checks = []
for phase in project["phases"]:
    if phase["kind"] != "confirmation":
        continue
    snapshot = phase["snapshot"]
    old_x = np.asarray(snapshot["matrix"]["X"], dtype=float)
    old_y = np.asarray(snapshot["matrix"]["y"], dtype=float)
    frozen = sm.OLS(old_y, old_x, missing="raise", hasconst=True).fit()
    np.testing.assert_allclose(frozen.params, [c["value"] for c in snapshot["coefficients"]], rtol=1e-8, atol=1e-8)
    for point in snapshot["predictions"]:
        prediction = frozen.get_prediction(np.asarray([point["x"]])).summary_frame(alpha=1-snapshot["model"]["confidence"])
        np.testing.assert_allclose(float(prediction["mean"].iloc[0]), point["mean"], rtol=1e-8, atol=1e-8)
        np.testing.assert_allclose(prediction[["mean_ci_lower", "mean_ci_upper"]].iloc[0], point["meanCI"], rtol=1e-7, atol=1e-7)
        np.testing.assert_allclose(prediction[["obs_ci_lower", "obs_ci_upper"]].iloc[0], point["predictionCI"], rtol=1e-7, atol=1e-7)
    confirmation_checks.append({"phase": phase["id"], "predictions": len(snapshot["predictions"]), "training_revision": snapshot["trainingRevision"]})
report["frozen_confirmation_checks"] = confirmation_checks

def clean(value):
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    return value

(root / "reproduction.json").write_text(json.dumps(clean(report), indent=2, allow_nan=False) + "\n")
print(f"Verified {report['n']} measured runs, {len(result.params)} coefficients and uncertainty. Wrote reproduction.json.")
