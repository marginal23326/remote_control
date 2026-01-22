use std::sync::{Arc, Mutex};
use sysinfo::{System, Networks};
use crate::services::input::InputManager;
use crate::services::shell::ShellManager;
use crate::services::screen::ScreenManager;
use crate::services::files::FileManager;
use crate::config::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,
    pub sys: Arc<Mutex<System>>,
    pub networks: Arc<Mutex<Networks>>,
    pub input: Arc<Mutex<InputManager>>,
    pub shell: Arc<Mutex<ShellManager>>,
    pub screen: Arc<Mutex<ScreenManager>>,
    pub files: Arc<Mutex<FileManager>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let networks = Networks::new_with_refreshed_list();
        let input = InputManager::new();
        let shell = ShellManager::new();
        let screen = ScreenManager::new();
        let files = FileManager::new();

        Self {
            config: Arc::new(Mutex::new(config)),
            sys: Arc::new(Mutex::new(sys)),
            networks: Arc::new(Mutex::new(networks)),
            input: Arc::new(Mutex::new(input)),
            shell: Arc::new(Mutex::new(shell)),
            screen: Arc::new(Mutex::new(screen)),
            files: Arc::new(Mutex::new(files)),
        }
    }
}
pub type SharedState = Arc<AppState>;