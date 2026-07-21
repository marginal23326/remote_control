use crate::config::AppConfig;
use crate::services::audio::AudioManager;
use crate::services::camera::CameraManager;
use crate::services::input::InputManager;
use crate::services::screen::ScreenManager;
use crate::services::shell::ShellManager;
use crate::services::tasks::TaskManager;
use parking_lot::RwLock;
use std::sync::Arc;
use sysinfo::{Networks, System};
use tokio::sync::OnceCell;

#[derive(Clone)]
pub struct WanInfo {
    pub ip: String,
    pub asn: String,
    pub isp: String,
    pub country: String,
    pub timezone: String,
}

impl WanInfo {
    pub fn na() -> Self {
        Self {
            ip: "N/A".to_string(),
            asn: "N/A".to_string(),
            isp: "N/A".to_string(),
            country: "N/A".to_string(),
            timezone: "N/A".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub sys: Arc<RwLock<System>>,
    pub networks: Arc<RwLock<Networks>>,
    pub input: InputManager,
    pub shell: ShellManager,
    pub screen: Arc<ScreenManager>,
    pub tasks: Arc<TaskManager>,
    pub audio: Arc<AudioManager>,
    pub camera: Arc<CameraManager>,
    pub wan_info: Arc<OnceCell<WanInfo>>,
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
        let tasks = TaskManager::new(sys_shared.clone());
        let audio = AudioManager::new();
        let camera = CameraManager::new();

        Self {
            config: Arc::new(config),
            sys: sys_shared,
            networks: Arc::new(RwLock::new(networks)),
            input,
            shell,
            screen: Arc::new(screen),
            tasks: Arc::new(tasks),
            audio: Arc::new(audio),
            camera: Arc::new(camera),
            wan_info: Arc::new(OnceCell::new()),
        }
    }
}
pub type SharedState = AppState;
