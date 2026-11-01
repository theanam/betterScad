# Models

Weights the app runs in the browser, committed rather than fetched: a build
that reaches the network for a required asset is a build that breaks the day
the host does. Nothing here is downloaded until the feature that needs it is
used, and the download is said up front.

## `u2netp.onnx`

U²-Net "portable", salient object detection: the model behind the drawing
tool's *Trace the subject*. 2.4 MB, a 320×320 picture in, a 320×320 map of
where the subject is out.

| | |
| --- | --- |
| Licence | Apache-2.0 |
| Paper | Qin et al., *U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection*, Pattern Recognition 106 (2020) |
| Source | https://github.com/xuebinqin/U-2-Net |
| ONNX export | https://huggingface.co/BritishWerewolf/U-2-Netp |
| Trained on | DUTS-TR |

Apache-2.0 asks that changes be stated. The weights are the published float32
export converted to float16 (`onnxconverter_common.float16`, inputs and
outputs kept float32), which halves the file and leaves the output all but
identical. Nothing else is altered.

The runtime is [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
(MIT), whose WebAssembly the build emits from `node_modules`; it is not
committed here.
