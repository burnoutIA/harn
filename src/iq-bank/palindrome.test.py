
# Tests de l'épreuve « prochain_palindrome » (banc d'intelligence, palier expert).
# Réponses vérifiées : force brute jusqu'à 200 000, solution de référence au-delà.
import signal

def _trop_long(*_):
    raise TimeoutError()

signal.signal(signal.SIGALRM, _trop_long)
_CAS = [
    (0, 1), (8, 9), (9, 11), (10, 11), (99, 101), (808, 818), (1991, 2002),
    (12921, 13031), (999, 1001), (123456789, 123464321),
    (12345678901234567, 12345678987654321),
    (99999999999999999, 100000000000000001),
    (10 ** 17, 100000000000000001),
    (123456789987654321, 123456790097654321),
    (98765432123456788, 98765432123456789),
]
_ok = 0
for _n, _attendu in _CAS:
    signal.alarm(2)
    try:
        if prochain_palindrome(_n) == _attendu:
            _ok += 1
    except BaseException:
        pass
    finally:
        signal.alarm(0)
    print(f"RESULTAT-@@JETON@@ {_ok}/{len(_CAS)}", flush=True)
