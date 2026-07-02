import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";
const generateBtn = document.getElementById('generateBtn');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');
const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');
const finalVideo = document.getElementById('finalVideo');
const downloadLink = document.getElementById('downloadLink');
let imagePipeline = null;
status.innerText = "Engine ready. Click generate to initialize the AI model.";
generateBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if(!prompt) {
        alert("Please type an actual prompt first!");
        return;
    }
    try {
        generateBtn.disabled = true;
        finalVideo.style.display = "none";
        downloadLink.style.display = "none";
        if (!imagePipeline) {
            status.innerText = "Downloading AI Model to your browser cache... (This takes a moment the first time)";
            imagePipeline = await pipeline('text-to-image', 'onnx-community/sd-turbo', {
                device: 'webgpu', // Uses WebGPU for fast generation. Falls back to WASM if unavailable.
            });
        }
        status.innerText = "AI is dreaming up your image frame...";
        const aiOutput = await imagePipeline(prompt, {
            num_inference_steps: 1,
            width: 512,
            height: 512,
        });
        const aiImage = await rawOutputToImage(aiOutput);
        status.innerText = "Animating AI generation into video stream...";
        const videoStream = canvas.captureStream(30); 
        const mediaRecorder = new MediaRecorder(videoStream, { mimeType: 'video/webm;codecs=vp9' });
        const chunks = [];
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            const videoURL = URL.createObjectURL(blob);
            finalVideo.src = videoURL;
            finalVideo.style.display = "block";
            downloadLink.href = videoURL;
            downloadLink.download = "ai_generated_video.webm";
            downloadLink.style.display = "inline-block";
            status.innerText = "Real AI Generation complete!";
            generateBtn.disabled = false;
        };
        mediaRecorder.start();
        let totalFrames = 120; // ~4 seconds @ 30fps
        for (let i = 0; i < totalFrames; i++) {
            renderAiAnimation(aiImage, prompt, i, totalFrames);
            await new Promise(r => setTimeout(r, 33)); 
        }
        mediaRecorder.stop();

    } catch (error) {
        console.error(error);
        status.innerText = "Error: " + error.message + ". Make sure your browser supports WebGPU!";
        generateBtn.disabled = false;
    }
});
async function rawOutputToImage(output) {
    const canvasTmp = document.createElement('canvas');
    canvasTmp.width = output.width;
    canvasTmp.height = output.height;
    const ctxTmp = canvasTmp.getContext('2d');
    const imgData = ctxTmp.createImageData(output.width, output.height);
    imgData.data.set(output.data);
    ctxTmp.putImageData(imgData, 0, 0);
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = canvasTmp.toDataURL();
    });
}
function renderAiAnimation(aiImage, promptText, frame, total) {
    const progress = frame / total;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const zoomFactor = 1 + (progress * 0.15); 
    const w = canvas.width * zoomFactor;
    const h = canvas.height * zoomFactor;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - h) / 2;
    ctx.drawImage(aiImage, x, y, w, h);
    const gradient = ctx.createLinearGradient(0, canvas.height * 0.7, 0, canvas.height);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 22px Georgia';
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 4;
    ctx.textAlign = 'center';
    ctx.fillText(`"${promptText}"`, canvas.width / 2, canvas.height - 30);
    ctx.shadowBlur = 0; // reset
}
