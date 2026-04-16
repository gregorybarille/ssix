use crate::models::{Credential, CredentialKind};
use crate::storage::{load_data, save_data};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AddCredentialInput {
    pub name: String,
    pub username: String,
    pub kind: CredentialKind,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCredentialInput {
    pub id: String,
    pub name: String,
    pub username: String,
    pub kind: CredentialKind,
}

#[tauri::command]
pub fn get_credentials() -> Result<Vec<Credential>, String> {
    let data = load_data()?;
    Ok(data.credentials)
}

#[tauri::command]
pub fn add_credential(input: AddCredentialInput) -> Result<Credential, String> {
    let mut data = load_data()?;
    let credential = Credential::new(input.name, input.username, input.kind);
    data.credentials.push(credential.clone());
    save_data(&data)?;
    Ok(credential)
}

#[tauri::command]
pub fn update_credential(input: UpdateCredentialInput) -> Result<Credential, String> {
    let mut data = load_data()?;
    let idx = data.credentials.iter().position(|c| c.id == input.id)
        .ok_or_else(|| "Credential not found".to_string())?;
    data.credentials[idx].name = input.name;
    data.credentials[idx].username = input.username;
    data.credentials[idx].kind = input.kind;
    let updated = data.credentials[idx].clone();
    save_data(&data)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_credential(id: String) -> Result<(), String> {
    let mut data = load_data()?;
    data.credentials.retain(|c| c.id != id);
    save_data(&data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::{Credential, CredentialKind};

    #[test]
    fn test_credential_new() {
        let kind = CredentialKind::Password { password: "secret".to_string() };
        let cred = Credential::new("test".to_string(), "user".to_string(), kind);
        assert_eq!(cred.name, "test");
        assert_eq!(cred.username, "user");
        assert!(!cred.id.is_empty());
    }

    #[test]
    fn test_credential_ssh_key() {
        let kind = CredentialKind::SshKey {
            private_key_path: "/home/user/.ssh/id_rsa".to_string(),
            passphrase: None,
        };
        let cred = Credential::new("my_key".to_string(), "admin".to_string(), kind);
        assert_eq!(cred.name, "my_key");
    }
}
