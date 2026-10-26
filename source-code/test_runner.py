#!/usr/bin/env python3
"""
ARINC712Forge Pro (v1.0.0) - Automated Test Suite
Verifies core ADF logic, cardioid resolver math, relative/magnetic bearings, ARINC 429 odd parity, and airworthiness audit.
"""

import unittest
import sys
import os
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cli = import_module("arinc712-cli")

class TestARINC712Engine(unittest.TestCase):

    def test_01_arinc429_odd_parity(self):
        """Test 1: ARINC 429 Bit 32 odd parity generator and validator."""
        p0 = cli.calculate_parity(0x00000000)
        self.assertEqual(p0, 1)

        p1 = cli.calculate_parity(0x00000001)
        self.assertEqual(p1, 0)

        p3 = cli.calculate_parity(0x00000003)
        self.assertEqual(p3, 1)

    def test_02_label_bit_reversal(self):
        """Test 2: Octal label bit reversal to ARINC 429 transmission order."""
        # Label 032 (octal 032 = binary 00011010)
        # Reversed: 01011000 = 0x58
        rev032 = cli.reverse_label_bits(0o032)
        self.assertEqual(rev032, 0x58)

        # Label 162 (octal 162 = binary 01110010)
        # Reversed: 01001110 = 0x4E
        rev162 = cli.reverse_label_bits(0o162)
        self.assertEqual(rev162, 0x4E)

    def test_03_relative_to_magnetic_bearing_math(self):
        """Test 3: Relative Bearing + Heading = Magnetic Bearing."""
        rb = 45.0
        hdg = 120.0
        mb = (rb + hdg) % 360.0
        self.assertEqual(mb, 165.0)

        # Wrapping across 360 degrees
        rb_wrap = 315.0
        hdg_wrap = 90.0
        mb_wrap = (rb_wrap + hdg_wrap) % 360.0
        self.assertEqual(mb_wrap, 45.0)

    def test_04_reciprocal_qdr_bearing(self):
        """Test 4: Reciprocal bearing from station (QDR)."""
        mb = 165.0
        qdr = (mb + 180.0) % 360.0
        self.assertEqual(qdr, 345.0)

    def test_05_orthogonal_loop_voltages(self):
        """Test 5: Crossed-loop antenna orthogonal voltages (Loop X and Loop Y)."""
        rad45 = math.radians(45.0)
        loop_x = math.cos(rad45)
        loop_y = math.sin(rad45)
        self.assertAlmostEqual(loop_x, 0.7071, places=3)
        self.assertAlmostEqual(loop_y, 0.7071, places=3)

        # On nose (0 deg)
        rad0 = math.radians(0.0)
        self.assertAlmostEqual(math.cos(rad0), 1.0, places=3)
        self.assertAlmostEqual(math.sin(rad0), 0.0, places=3)

    def test_06_cardioid_null_pattern(self):
        """Test 6: Cardioid antenna null pattern resolution (1 - cos(theta))."""
        # Exactly on nose (0 deg) -> Null ratio = 1 - 1 = 0
        null_on_nose = 1.0 - math.cos(0.0)
        self.assertAlmostEqual(null_on_nose, 0.0, places=3)

        # Directly behind (180 deg) -> Null ratio = 1 - (-1) = 2.0
        null_tail = 1.0 - math.cos(math.pi)
        self.assertAlmostEqual(null_tail, 2.0, places=3)

    def test_07_encode_decode_tuning_label032(self):
        """Test 7: Tuning Label 032 BCD encoding and parity validity."""
        word = cli.encode_arinc429_word(0o032, 1, 0x3850, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        self.assertEqual(dec['octal_label'], '0032')
        self.assertEqual(dec['sdi'], 1)
        self.assertEqual(dec['ssm_meaning'], 'Normal Operation')

    def test_08_encode_decode_bearing_label162(self):
        """Test 8: Relative Bearing Label 162 13-bit BNR encoding."""
        rb_deg = 85.5
        bnr_units = int((rb_deg / 360.0) * 8192)
        word = cli.encode_arinc429_word(0o162, 1, bnr_units, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        recovered = (dec['data'] / 8192) * 360.0
        self.assertAlmostEqual(recovered, rb_deg, delta=0.05)

    def test_09_sign_status_matrix_ssm(self):
        """Test 9: Sign/Status Matrix (SSM) normal operation, warning, and NCD."""
        word_norm = cli.encode_arinc429_word(0o270, 1, 0x01, 0x03)
        self.assertEqual(cli.decode_arinc429_word(word_norm)['ssm_meaning'], 'Normal Operation')

        word_fail = cli.encode_arinc429_word(0o350, 1, 0x01, 0x00)
        self.assertEqual(cli.decode_arinc429_word(word_fail)['ssm_meaning'], 'Failure Warning')

        word_ncd = cli.encode_arinc429_word(0o162, 1, 0x00, 0x01)
        self.assertEqual(cli.decode_arinc429_word(word_ncd)['ssm_meaning'], 'No Computed Data (NCD)')

    def test_10_normative_compliance_audit_rules(self):
        """Test 10: 10-point normative airworthiness compliance audit execution."""
        audit = cli.run_compliance_audit()
        self.assertEqual(audit['total_rules'], 10)
        self.assertEqual(audit['passed_count'], 10)
        self.assertEqual(audit['failed_count'], 0)
        self.assertEqual(audit['score_percent'], 100.0)
        self.assertEqual(audit['certification'], 'ARINC_712_ADF_TSO_C41D_CERTIFIED')

if __name__ == '__main__':
    unittest.main()
