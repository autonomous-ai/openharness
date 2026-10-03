/** Apply source privacy in SQL before candidate limits, including every native lineage root. */
export function visibleEvidenceSql(alias = 'm'): string {
  return `NOT EXISTS (SELECT 1 FROM evidence e LEFT JOIN sources s ON s.id=e.source_id
    WHERE e.memory_id=${alias}.id AND e.revision=${alias}.revision AND (s.id IS NULL
      OR (s.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.included=1))
      OR EXISTS (SELECT 1 FROM memory_session_policy policy WHERE policy.engine=json_extract(s.data,'$.engine')
        AND policy.session_id=json_extract(s.data,'$.sessionId') AND policy.included=0)
      OR EXISTS (SELECT 1 FROM json_each(s.data,'$.rootIds') lineage LEFT JOIN sources root ON root.id=lineage.value
        WHERE root.id IS NULL
          OR (root.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=root.project_id AND p.included=1))
          OR EXISTS (SELECT 1 FROM memory_session_policy policy WHERE policy.engine=json_extract(root.data,'$.engine')
            AND policy.session_id=json_extract(root.data,'$.sessionId') AND policy.included=0))))`
}
