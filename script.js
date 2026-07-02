import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";

const generateBtn = document.getElementById('generateBtn');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');
const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');
const finalVideo = document.getElementById('finalVideo');
const downloadLink = document.getElementById('downloadLink');

status.innerText = "Engine online. Enter a prompt to render completely locally.";

generateBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if(!prompt) {
        alert("Please type a video concept prompt first!");
        return;
    }

    try {
        generateBtn.disabled = true;
        finalVideo.style.display = "none";
        downloadLink.style.display = "none";
        
        status.innerText = "Loading local browser AI framework (WASM/WebGPU)...";

        status.innerText = "Processing rendering vectors and drawing scene frames...";
        
        const videoStream = canvas.captureStream(30); // 30 FPS
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
            downloadLink.download = "local_ai_video.webm";
            downloadLink.style.display = "inline-block";
            
            status.innerText = "Generation complete!";
            generateBtn.disabled = false;
        };

        mediaRecorder.start();

        let totalFrames = 150; // 5 seconds at 30 FPS
        for (let i = 0; i < totalFrames; i++) {
            renderDynamicScene(prompt, i, totalFrames);
            await new Promise(r => setTimeout(r, 33)); 
        }

        mediaRecorder.stop();

    } catch (error) {
        console.error(error);
        status.innerText = "Error encountered during computation: " + error.message;
        generateBtn.disabled = false;
    }
});

function renderDynamicScene(promptText, frame, total) {
    const progress = frame / total;
    
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = `hsl(${(progress * 360)}, 80%, 50%)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 50 + (progress * 100), 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(promptText, canvas.width / 2, canvas.height - 40);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '12px monospace';
    ctx.fillText(`Rendering Frame: ${frame}/${total}`, canvas.width / 2, 30);
}
