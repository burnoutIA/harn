
// Tests de l'épreuve « rle_decode » (banc d'intelligence, palier expert).
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let cas: Vec<(&str, Option<String>)> = vec![
        ("", Some(String::new())),
        ("3a2b1c", Some("aaabbc".to_string())),
        ("12x", Some("x".repeat(12))),
        ("2é3ß", Some("ééßßß".to_string())),
        ("1 2-", Some(" --".to_string())),
        ("1000z", Some("z".repeat(1000))),
        ("a", None),
        ("3", None),
        ("3a2", None),
        ("0a", None),
        ("07a", None),
        ("1001a", None),
        ("99999999999999999999999a", None),
        ("2a0b", None),
    ];
    let total = cas.len();
    let mut ok = 0;
    for (entree, attendu) in cas {
        let entree = entree.to_string();
        if std::panic::catch_unwind(move || rle_decode(&entree)).ok() == Some(attendu) {
            ok += 1;
        }
        println!("RESULTAT-@@JETON@@ {}/{}", ok, total);
    }
}
