"""The shipped corpus loads without external classification files."""
import hashlib
import json
from pathlib import Path
import unittest

from kag.builder.inputs import CLASSIFICATIONS, SOURCE_FILES, load_inputs


ROOT = Path(__file__).resolve().parents[2]


class VersionedInputTests(unittest.TestCase):
    def test_corpus_classification_and_file_locators(self):
        contract = json.loads((ROOT/'kag/schema/schema_contract.json').read_bytes())
        inputs = load_inputs(ROOT, contract)
        self.assertTrue(inputs.raw.xrefs)
        self.assertTrue(all(row.record['downstream_use'] in CLASSIFICATIONS for row in inputs.raw.xrefs))
        for _, name in SOURCE_FILES:
            with self.subTest(name=name):
                self.assertEqual(inputs.raw.source_hashes[name], hashlib.sha256((ROOT/name).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
