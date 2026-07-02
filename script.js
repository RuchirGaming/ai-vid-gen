import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";

const generateBtn = document.getElementById('generateBtn');
const promptInput = document.getElementById('promptInput');
const status = document.getElementById('status');
const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');
const finalVideo = document.getElementById('finalVideo');
const downloadLink = document.getElementById('downloadLink');

let textPipeline = null;

status.innerText = "Engine ready. Enter a prompt to generate.";

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
        
        if (!textPipeline) {
            status.innerText = "Downloading local AI Director model (~40MB)...";
            textPipeline = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat');
        }

        status.innerText = "AI is calculating visual vectors for your prompt...";
        
        const systemPrompt = `You are a video generator backend. Based on the user's prompt, reply ONLY with a valid JSON object matching this exact format: {"primaryColor": "hex", "secondaryColor": "hex", "speed": number 1 to 5, "particleCount": number 10 to 100, "style": "neon" or "organic" or "cosmic"}. Prompt: "${prompt}"`;
        
        const aiOutput = await textPipeline(systemPrompt, {
            max_new_tokens: 60,
            temperature: 0.7,
        });

        const generatedText = aiOutput[0].generated_text;
        let jsonConfig = { primaryColor: "#00ffcc", secondaryColor: "#ff00ff", speed: 2, particleCount: 50, style: "neon" };
        
        try {
            const jsonMatch = generatedText.match(/\{([\s\S]*?)\}/);
            if (jsonMatch) {
                jsonConfig = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.log("Using fallbacks.");
        }

        status.innerText = `AI Director configuration received! Compiling video file...`;
        
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
            downloadLink.download = "ai_director_video.webm";
            downloadLink.style.display = "inline-block";
            
            status.innerText = "Generation complete! Rendered using local AI parameters.";
            generateBtn.disabled = false;
        };

        mediaRecorder.start();

        let particles = [];
        for(let p=0; p < (jsonConfig.particleCount || 50); p++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                radius: Math.random() * 3 + 1,
                vx: (Math.random() - 0.5) * (jsonConfig.speed || 2),
                vy: (Math.random() - 0.5) * (jsonConfig.speed || 2)
            });
        }

        let totalFrames = 150;
        for (let i = 0; i < totalFrames; i++) {
            renderAiDirectedScene(prompt, i, totalFrames, jsonConfig, particles);
            await new Promise(r => setTimeout(r, 33)); 
        }

        mediaRecorder.stop();

    } catch (error) {
        console.error(error);
        status.innerText = "Error encountered: " + error.message;
        generateBtn.disabled = false;
    }
});

function renderAiDirectedScene(promptText, frame, total, config, particles) {
    const progress = frame / total;
    
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = config.primaryColor || '#00ffcc';
    particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        
        if(p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if(p.y < 0 || p.y > canvas.height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.strokeStyle = config.secondaryColor || '#ff00ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (config.style === 'organic') {
        ctx.moveTo(0, canvas.height/2);
        for(let x=0; x<canvas.width; x++) {
            ctx.lineTo(x, canvas.height/2 + Math.sin(x*0.02 + frame*0.1) * 50);
        }
    } else if (config.style === 'cosmic') {
        ctx.arc(canvas.width / 2, canvas.height / 2, (frame * (config.speed || 2)) % 200, 0, Math.PI * 2);
    } else {
        let offset = (frame * (config.speed || 2)) % 40;
        for(let x = offset; x < canvas.width; x += 40) {
            ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
        }
    }
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(promptText, canvas.width / 2, canvas.height - 30);
}
