import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import qualify_precipitation as q
class Qualification(unittest.TestCase):
 def test_unknown_does_not_become_rain(self):
  self.assertIsNone(q.observed_code((True,'rain','unknown')))
  self.assertEqual(q.observed_code((True,'rain','showery')),'SHRA')
  self.assertEqual(q.observed_code((False,None,None)),'DRY')
 def test_matrix_and_false_classification(self):
  a=q.evaluate([('RA','RA'),('RA','DZ'),('DZ','DZ'),('DRY','RA')])
  self.assertEqual(a['accuracy'],.5)
  self.assertEqual(a['misclassification_rate'],.5)
  self.assertEqual(a['confusion']['RA']['DZ'],1)
  self.assertEqual(a['class_metrics']['RA']['precision'],.5)
  self.assertEqual(a['class_metrics']['RA']['recall'],.5)
  self.assertTrue(a['class_metrics']['RA']['insufficient'])
 def test_empty_and_hazards(self):
  self.assertIsNone(q.evaluate([])['accuracy'])
  self.assertEqual(q.normalize('FZDZ'),'FZ')
  self.assertEqual(q.normalize('VAR'),'VAR')
if __name__=='__main__':unittest.main()
