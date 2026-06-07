use crate::config::AppConfig;
use crate::services::audio::AudioManager;
use crate::services::files::FileManager;
use crate::services::input::InputManager;
use crate::services::screen::ScreenManager;
use crate::services::shell::ShellManager;
use crate::services::tasks::TaskManager;
use std::sync::{Arc, Mutex, RwLock};
use sysinfo::{Networks, System};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub sys: Arc<RwLock<System>>,
    pub networks: Arc<RwLock<Networks>>,
    pub input: Arc<InputManager>,
    pub shell: Arc<Mutex<ShellManager>>,
    pub screen: Arc<ScreenManager>,
    pub files: Arc<FileManager>,
    pub tasks: Arc<TaskManager>,
    pub audio: Arc<AudioManager>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        let sys_shared = Arc::new(RwLock::new(sys));

        let networks = Networks::new_with_refreshed_list();
        let input = InputManager::new();
        let shell = ShellManager::new();
        let screen = ScreenManager::new();
        let files = FileManager::new();
        let tasks = TaskManager::new(sys_shared.clone());
        let audio = AudioManager::new();

        Self {
            config: Arc::new(config),
            sys: sys_shared,
            networks: Arc::new(RwLock::new(networks)),
            input: Arc::new(input),
            shell: Arc::new(Mutex::new(shell)),
            screen: Arc::new(screen),
            files: Arc::new(files),
            tasks: Arc::new(tasks),
            audio: Arc::new(audio),
        }
    }
}
pub type SharedState = Arc<AppState>;
