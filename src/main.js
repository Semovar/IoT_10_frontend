import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';

Chart.register(zoomPlugin);

// ===== plugins =====

const neonGlow = {
    id: 'neonGlow',
    beforeDatasetDraw(chart, args) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.shadowColor = args.meta.dataset.options.borderColor;
        ctx.shadowBlur = 15;
    },
    afterDatasetDraw(chart) {
        chart.ctx.restore();
    }
};

const crosshair = {
    id: 'crosshair',
    afterDraw(chart) {
        const active = chart.tooltip?._active;
        if (!active?.length) return;

        const ctx = chart.ctx;
        const x = active[0].element.x;
        const y = active[0].element.y;

        ctx.save();
        ctx.strokeStyle = '#0ff';
        ctx.setLineDash([5,5]);

        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, chart.height);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chart.width, y);
        ctx.stroke();

        ctx.restore();
    }
};

Chart.register(neonGlow, crosshair);

// ===== helpers =====

function formatDateTimeEU(isoString) {
    const date = new Date(isoString);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yy} ${hh}:${min}`;
}

function movingAvg(arr, k=5) {
    return arr.map((_,i) =>
        arr.slice(Math.max(0,i-k), i+1)
           .reduce((a,b)=>a+b,0)/(Math.min(i+1,k))
    );
}

function resample(data, minutes) {
    if (!minutes) return data;

    const bucket = minutes * 60 * 1000;
    const grouped = {};

    data.forEach(p => {
        const t = new Date(p.timestamp).getTime();
        const key = Math.floor(t / bucket) * bucket;

        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(p.temperature);
    });

    return Object.keys(grouped).map(k => ({
        timestamp: new Date(Number(k)).toISOString(),
        temperature:
            grouped[k].reduce((a,b)=>a+b,0) / grouped[k].length
    }));
}

// ===== storage =====

function saveSettings(settings) {
    localStorage.setItem("dashboard", JSON.stringify(settings));
}

function loadSettings() {
    return JSON.parse(localStorage.getItem("dashboard") || "{}");
}

// ===== app =====

window.addEventListener("DOMContentLoaded", () => {

    const chartEl = document.getElementById('chart');
    const sensorList = document.getElementById('sensorList');

    const palette = [
        "#00ffff","#ff00ff","#00ff88","#ffaa00","#ff0055"
    ];

    let chart;
    let dataCache = {}; // Cache for sensor data

    async function getSensors() {
        const res = await fetch('/api/sensors');
        return res.json();
    }

    // Fetch data - uses cache or gets fresh data
    async function getData(sensorId, forceRefresh = false) {
        const now = new Date();
        const cacheAge = dataCache[sensorId]?.timestamp ? 
            now.getTime() - new Date(dataCache[sensorId].timestamp).getTime() : Infinity;
        
        // Use cache if less than 5 minutes old and not forcing refresh
        if (!forceRefresh && dataCache[sensorId] && cacheAge < 5 * 60 * 1000) {
            return dataCache[sensorId];
        }
        
        // Fetch fresh data - up to 7 days
        const url = `/api/measurements?sensorIds=${sensorId}&limit=5000`;
        const res = await fetch(url);
        const json = await res.json();
        
        // Cache the data
        dataCache[sensorId] = json;
        return json;
    }

    // Filter data by period
    function filterByPeriod(data, period) {
        const now = new Date();
        let start;

        switch (period) {
            case '1h':
                start = new Date(now.getTime() - 60 * 60 * 1000);
                break;
            case '6h':
                start = new Date(now.getTime() - 6 * 60 * 60 * 1000);
                break;
            case '24h':
                start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '7d':
                start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
                start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case 'custom':
                const dateFrom = document.getElementById('dateFrom').value;
                const dateTo = document.getElementById('dateTo').value;
                if (dateFrom && dateTo) {
                    const customStart = new Date(dateFrom);
                    const customEnd = new Date(dateTo);
                    return data.data
                        .filter(p => {
                            const t = new Date(p.timestamp);
                            return t >= customStart && t <= customEnd;
                        })
                        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                }
                return data.data;
            default:
                start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        }

        return data.data
            .filter(p => new Date(p.timestamp) >= start)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    async function init() {

        const sensors = await getSensors();
        const saved = loadSettings();

        sensors.forEach(s => {
            const label = document.createElement('label');
            const cb = document.createElement('input');

            cb.type = 'checkbox';
            cb.value = s.id;

            if (saved.sensors?.includes(s.id)) cb.checked = true;

            label.appendChild(cb);
            label.append(" " + (s.name || s.id));

            sensorList.appendChild(label);
        });

        // restore UI
        if (saved.resolution)
            document.getElementById("resolution").value = saved.resolution;

        if (saved.period)
            document.getElementById("period").value = saved.period;

        // Toggle custom date range visibility
        const periodSelect = document.getElementById("period");
        const customRange = document.getElementById("customRange");
        periodSelect.addEventListener("change", () => {
            customRange.style.display = periodSelect.value === "custom" ? "block" : "none";
        });
        customRange.style.display = periodSelect.value === "custom" ? "block" : "none";

        ["showRaw","showSmooth","showAvg"].forEach(id => {
            if (saved[id] !== undefined)
                document.getElementById(id).checked = saved[id];
        });

        chart = new Chart(chartEl, {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#0ff',
                            boxWidth: 10,
                            font: { size: 10 }
                        }
                    },
                    zoom: {
                        pan: {
                            enabled: true,
                            mode: 'x'
                        },
                        zoom: {
                            wheel: { enabled: true },
                            pinch: { enabled: true },
                            mode: 'x'
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#0ff' },
                        grid: { color: 'rgba(0,255,255,0.1)' }
                    },
                    y: {
                        ticks: { color: '#0ff' },
                        grid: { color: 'rgba(0,255,255,0.1)' }
                    }
                }
            }
        });

        load();
    }

    async function load() {

        const selected = Array.from(
            document.querySelectorAll('#sensorList input:checked')
        ).map(cb => cb.value);

        const period = document.getElementById("period").value;
        
        // Determine if we need fresh data (period > 7 days or custom range)
        const needsFreshData = ['30d', 'custom'].includes(period);

        const settings = {
            sensors: selected,
            resolution: document.getElementById("resolution").value,
            period: period,
            showRaw: document.getElementById("showRaw").checked,
            showSmooth: document.getElementById("showSmooth").checked,
            showAvg: document.getElementById("showAvg").checked
        };

        saveSettings(settings);

        if (!selected.length) return;

        const datasets = [];
        let labels = [];

        for (let i = 0; i < selected.length; i++) {

            const id = selected[i];
            // Fetch data - use cache for short periods, force refresh for long ones
            const json = await getData(id, needsFreshData);
            
            // Filter data by selected period (already sorted oldest -> newest)
            let data = filterByPeriod(json, period);

            data = resample(data, Number(settings.resolution));

            const temps = data.map(x => x.temperature);

            if (!labels.length)
                labels = data.map(x => formatDateTimeEU(x.timestamp));

            document.getElementById("currentTemp").innerText =
                temps[temps.length - 1].toFixed(2) + " °C";

            const color = palette[i % palette.length];

            if (settings.showRaw) {
                datasets.push({
                    label: id,
                    data: temps,
                    borderColor: color,
                    tension: 0.2
                });
            }

            if (settings.showSmooth) {
                datasets.push({
                    label: id + " smooth",
                    data: movingAvg(temps),
                    borderColor: color,
                    borderDash: [3,3]
                });
            }

            if (settings.showAvg) {
                const avg = temps.reduce((a,b)=>a+b,0)/temps.length;

                datasets.push({
                    label: id + " avg",
                    data: temps.map(() => avg),
                    borderColor: "#888",
                    borderDash: [5,5]
                });
            }

            document.getElementById("statsText").innerText =
                `Min: ${Math.min(...temps).toFixed(2)} | Max: ${Math.max(...temps).toFixed(2)}`;
        }

        chart.data.labels = labels;
        chart.data.datasets = datasets;
        chart.update();
    }

    document.getElementById('load').onclick = load;

    document.getElementById('resetZoom').onclick = () => {
        chart.resetZoom();
    };

    document.querySelectorAll("input, select").forEach(el => {
        el.addEventListener("change", load);
    });

    document.getElementById("uiScale").oninput = (e) => {
        document.body.style.transform = `scale(${e.target.value})`;
        document.body.style.transformOrigin = "top left";
    };

    init();
});