#!/usr/bin/env python3
import json
from pathlib import Path

# Rebuild the visibility component from archived operational model forecasts
# before exposing verification data to the frontend. This fills historical VIS
# skill even for hours predating local full-forecast snapshot archiving.
try:
    import backfill_visibility_verification as visibility_backfill
    visibility_backfill.main()
except Exception as exc:
    # Do not block the entire learning/deploy pipeline if the external archive
    # is temporarily unavailable. Existing verified data remains valid.
    print('visibility verification backfill warning:', exc)

root = Path(__file__).resolve().parents[1]
learning = root / 'data' / 'learning'
skill_path = learning / 'cloud-skill.json'
verification_path = learning / 'model-verification.json'

skill = json.loads(skill_path.read_text(encoding='utf-8'))
verification = json.loads(verification_path.read_text(encoding='utf-8'))
if skill.get('schema') != 'prognozaepir-cloud-learning-v1':
    raise SystemExit('Unexpected cloud-skill schema')
if verification.get('schema') != 'prognozaepir-model-verification-v1':
    raise SystemExit('Unexpected model-verification schema')
skill['model_verification'] = verification
skill_path.write_text(json.dumps(skill, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('model verification embedded in cloud-skill.json')
