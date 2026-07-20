use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::path::Path;
use tokio::fs;
use uuid::Uuid;

const CONFIG_FILE: &str = "user_config.json";

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AppConfig {
    pub password_hash: String,
    pub jwt_secret: String,
    pub port: u16,
    pub stun_server: Option<String>,
}

// Default used only for internal fallback
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            password_hash: String::new(),
            jwt_secret: String::new(),
            port: 5000,
            stun_server: None,
        }
    }
}

pub struct ConfigManager;

impl ConfigManager {
    pub async fn load() -> Result<AppConfig> {
        let mut config = if Path::new(CONFIG_FILE).exists() {
            let content = fs::read_to_string(CONFIG_FILE).await?;
            serde_json::from_str(&content)?
        } else {
            println!("\n=== First Time Setup ===");
            println!("No configuration found. Please create your admin password.\n");

            let password = Self::prompt_password()?;
            let port_str = Self::prompt_input("Enter port (default 5000): ")?;

            let port = if port_str.is_empty() {
                5000
            } else {
                port_str.parse::<u16>().unwrap_or(5000)
            };

            println!("\nGenerating security keys...");
            let salt = Uuid::new_v4().as_bytes().to_vec();
            let hash = Sha256::new()
                .chain_update(&salt)
                .chain_update(password.as_bytes())
                .finalize();
            let password_hash = format!("{}:{}", BASE64.encode(&salt), BASE64.encode(hash));
            let jwt_secret = Uuid::new_v4().to_string();

            let config = AppConfig {
                password_hash,
                jwt_secret,
                port,
                stun_server: None,
            };

            let json = serde_json::to_string_pretty(&config)?;
            fs::write(CONFIG_FILE, json).await?;
            println!("Configuration saved to '{}'. Starting server...\n", CONFIG_FILE);

            config
        };

        if let Ok(env_stun) = std::env::var("STUN_SERVER") {
            config.stun_server = Some(env_stun);
        }

        Ok(config)
    }

    fn prompt_input(prompt: &str) -> Result<String> {
        print!("{}", prompt);
        io::stdout().flush()?; // Ensure prompt appears before input
        let mut buffer = String::new();
        io::stdin().read_line(&mut buffer)?;
        Ok(buffer.trim_end_matches(['\r', '\n']).to_string())
    }

    fn prompt_password() -> Result<String> {
        loop {
            let p1 = rpassword::prompt_password("Enter password: ")?;
            if p1.is_empty() {
                println!("Password cannot be empty.");
                continue;
            }

            let p2 = rpassword::prompt_password("Confirm password: ")?;

            if p1 == p2 {
                return Ok(p1);
            }
            println!("Passwords do not match. Please try again.\n");
        }
    }
}
