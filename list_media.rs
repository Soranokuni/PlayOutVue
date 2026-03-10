fn main() {
    if let Ok(entries) = std::fs::read_dir("C:\\CasparCG\\Media") {
        for entry in entries {
            if let Ok(entry) = entry {
                println!("{:?}", entry.file_name());
            }
        }
    } else {
        println!("Could not read C:\\CasparCG\\Media");
    }
}
