use std::sync::{Arc, Mutex};
use sysinfo::{System, Networks};
use crate::services::input::InputManager;
use crate::services::shell::ShellManager;
use crate::services::screen::ScreenManager;
use crate::services::files::FileManager;
use crate::services::tasks::TaskManager;
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
    pub tasks: Arc<Mutex<TaskManager>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        
        let sys_shared = Arc::new(Mutex::new(sys)); 
        
        let networks = Networks::new_with_refreshed_list();
        let input = InputManager::new();
        let shell = ShellManager::new();
        let screen = ScreenManager::new();
        let files = FileManager::new();
        let tasks = TaskManager::new(sys_shared.clone()); 

        Self {
            config: Arc::new(Mutex::new(config)),
            sys: sys_shared, // Use the shared one
            networks: Arc::new(Mutex::new(networks)),
            input: Arc::new(Mutex::new(input)),
            shell: Arc::new(Mutex::new(shell)),
            screen: Arc::new(Mutex::new(screen)),
            files: Arc::new(Mutex::new(files)),
            tasks: Arc::new(Mutex::new(tasks)),
        }
    }
}
pub type SharedState = Arc<AppState>;