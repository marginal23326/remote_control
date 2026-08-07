use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer::glib;
use gstreamer_app as gst_app;

use super::ScreenManager;

const LEAKY_QUEUE: &str = "queue leaky=downstream max-size-buffers=2 max-size-time=0 max-size-bytes=0";

pub(crate) fn encode_and_webrtc_tail(encoder_pipeline_str: &str) -> String {
    format!(
        "videoconvert ! \
         video/x-raw,format=NV12 ! \
         {LEAKY_QUEUE} ! \
         {encoder_pipeline_str} ! \
         rtph264pay config-interval=-1 aggregate-mode=zero-latency ! \
         webrtcbin name=webrtc bundle-policy=max-bundle latency=0"
    )
}

#[derive(Serialize, Clone, Debug, TS)]
#[serde(tag = "value_type", rename_all = "lowercase")]
#[ts(export, export_to = "bindings.ts")]
pub enum EncoderPropertyConstraint {
    Bool,
    Int { min: i64, max: i64 },
    Enum { enum_values: Vec<String> },
    String,
}

fn constraint_from_pspec(pspec: &glib::ParamSpec) -> EncoderPropertyConstraint {
    if pspec.downcast_ref::<glib::ParamSpecBoolean>().is_some() {
        return EncoderPropertyConstraint::Bool;
    }

    macro_rules! int_range {
        ($($ty:ty),+ $(,)?) => {
            $(
                if let Some(p) = pspec.downcast_ref::<$ty>() {
                    return EncoderPropertyConstraint::Int { min: p.minimum() as i64, max: p.maximum() as i64 };
                }
            )+
        };
    }
    int_range!(
        glib::ParamSpecInt,
        glib::ParamSpecUInt,
        glib::ParamSpecInt64,
        glib::ParamSpecUInt64,
    );

    if let Some(p) = pspec.downcast_ref::<glib::ParamSpecEnum>() {
        let enum_values = p.enum_class().values().iter().map(|v| v.nick().to_string()).collect();
        return EncoderPropertyConstraint::Enum { enum_values };
    }

    EncoderPropertyConstraint::String
}

fn encoder_constraints(encoder: &gst::Element, names: &[&str]) -> HashMap<String, EncoderPropertyConstraint> {
    names
        .iter()
        .filter_map(|&name| Some((name.to_string(), constraint_from_pspec(&encoder.find_property(name)?))))
        .collect()
}

pub(crate) struct EncoderInfo {
    pub(crate) name: &'static str,
    pub(crate) pipeline_str: &'static str,
    pub(crate) default_properties: &'static [(&'static str, &'static str)],
    pub(crate) min_dim: u32,
}

pub(crate) fn detect_encoder() -> EncoderInfo {
    #[cfg(windows)]
    {
        if gst::Registry::get()
            .find_feature("mfh264enc", gst::PluginFeature::static_type())
            .is_some()
        {
            return EncoderInfo {
                name: "mfh264enc",
                pipeline_str: "mfh264enc name=enc low-latency=true rc-mode=0 gop-size=30 ref=1",
                default_properties: &[
                    ("low-latency", "true"),
                    ("rc-mode", "0"),
                    ("gop-size", "30"),
                    ("ref", "1"),
                ],
                min_dim: 64,
            };
        }
    }

    #[cfg(target_os = "linux")]
    {
        if gst::Registry::get()
            .find_feature("vah264enc", gst::PluginFeature::static_type())
            .is_some()
        {
            return EncoderInfo {
                name: "vah264enc",
                pipeline_str: "vah264enc name=enc target-usage=7 rate-control=cbr key-int-max=30 ref-frames=1 cpb-size=100",
                default_properties: &[
                    ("target-usage", "7"),
                    ("rate-control", "cbr"),
                    ("key-int-max", "30"),
                    ("ref-frames", "1"),
                    ("cpb-size", "100"),
                ],
                min_dim: 128,
            };
        }
    }

    tracing::warn!("No hardware encoder found. Falling back to CPU (x264enc)");
    EncoderInfo {
        name: "x264enc",
        pipeline_str: "x264enc name=enc tune=zerolatency speed-preset=ultrafast",
        default_properties: &[("tune", "zerolatency"), ("speed-preset", "ultrafast")],
        min_dim: 2,
    }
}

pub(crate) fn apply_encoder_properties(encoder: &gst::Element, properties: &HashMap<String, String>) -> Vec<String> {
    let mut rejected = Vec::new();
    for (key, value) in properties {
        tracing::trace!("Setting encoder property {key}={value}");
        let pspec = match encoder.find_property(key) {
            Some(pspec) => pspec,
            None => {
                tracing::warn!("Unknown encoder property: {key}");
                rejected.push(key.clone());
                continue;
            }
        };
        match glib::Value::deserialize_with_pspec(value, &pspec) {
            Ok(v) => {
                encoder.set_property(key, v);
            }
            Err(_) => {
                tracing::warn!("Invalid value for encoder property {key}: {value}");
                rejected.push(key.clone());
            }
        }
    }
    rejected
}

pub(crate) struct PipelineHandles {
    pub(crate) pipeline: gst::Pipeline,
    pub(crate) appsrc: gst_app::AppSrc,
    pub(crate) webrtcbin: gst::Element,
    pub(crate) encoder: gst::Element,
    pub(crate) min_dim: u32,
}

impl ScreenManager {
    pub(crate) fn build_pipeline(&self) -> anyhow::Result<PipelineHandles> {
        let encoder_info = detect_encoder();
        *self.encoder_type.lock() = encoder_info.name.to_string();

        {
            let mut s = self.settings.lock();
            if s.encoder_properties.is_empty() {
                s.encoder_properties = encoder_info
                    .default_properties
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
            }
        }

        let pipeline_str = format!(
            "appsrc name=src \
                is-live=true \
                block=false \
                format=time \
                do-timestamp=true \
                max-buffers=2 \
                leaky-type=downstream \
                max-bytes=0 ! \
             {LEAKY_QUEUE} ! \
             {}",
            encode_and_webrtc_tail(encoder_info.pipeline_str)
        );

        let pipeline = gst::parse::launch(&pipeline_str)
            .map_err(|e| anyhow::anyhow!("Failed to create pipeline: {e}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast to Pipeline"))?;

        let appsrc = pipeline
            .by_name("src")
            .ok_or_else(|| anyhow::anyhow!("appsrc not found"))?
            .dynamic_cast::<gst_app::AppSrc>()
            .map_err(|_| anyhow::anyhow!("Failed to cast to AppSrc"))?;

        let webrtcbin = pipeline
            .by_name("webrtc")
            .ok_or_else(|| anyhow::anyhow!("webrtcbin not found"))?;

        let encoder = pipeline
            .by_name("enc")
            .ok_or_else(|| anyhow::anyhow!("Encoder not found"))?;

        let property_names: Vec<&str> = encoder_info.default_properties.iter().map(|(k, _)| *k).collect();
        *self.encoder_property_constraints.lock() = encoder_constraints(&encoder, &property_names);

        let default_bitrate = self.settings.lock().bitrate;
        encoder.set_property_from_str("bitrate", &default_bitrate.to_string());

        let encoder_properties = self.settings.lock().encoder_properties.clone();
        apply_encoder_properties(&encoder, &encoder_properties);

        pipeline
            .set_state(gst::State::Ready)
            .map_err(|e| anyhow::anyhow!("Failed to set pipeline to Ready: {e}"))?;

        Ok(PipelineHandles {
            pipeline,
            appsrc,
            webrtcbin,
            encoder,
            min_dim: encoder_info.min_dim,
        })
    }
}
