use crate::config::AppConfig;
use crate::services::audio::AudioManager;
use crate::services::camera::CameraManager;
use crate::services::input::InputManager;
use crate::services::screen::ScreenManager;
use crate::services::shell::ShellManager;
use crate::services::system::WanInfo;
use crate::services::tasks::TaskManager;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use tokio::sync::OnceCell;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub input: InputManager,
    pub shell: ShellManager,
    pub screen: Arc<ScreenManager>,
    pub tasks: Arc<TaskManager>,
    pub audio: Arc<AudioManager>,
    pub camera: Arc<CameraManager>,
    pub wan_info: Arc<OnceCell<WanInfo>>,
    pub task_watchers: Arc<AtomicUsize>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let input = InputManager::new();
        let shell = ShellManager::new();
        let screen = ScreenManager::new();
        let tasks = TaskManager::new();
        let audio = AudioManager::new();
        let camera = CameraManager::new();

        Self {
            config: Arc::new(config),
            input,
            shell,
            screen: Arc::new(screen),
            tasks: Arc::new(tasks),
            audio: Arc::new(audio),
            camera: Arc::new(camera),
            wan_info: Arc::new(OnceCell::new()),
            task_watchers: Arc::new(AtomicUsize::new(0)),
        }
    }
}
