// Native MediaPipe body indices shared with the 17-point AI evidence.
export const MOTION_FITNESS_BODY_INDICES = Object.freeze([0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]);
const BODY_LINKS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];
const finite = value => typeof value==='number'&&Number.isFinite(value);

export function buildMotionOverlay(points,width,height) {
  if(!Array.isArray(points)||points.length!==33||!finite(width)||!finite(height)||width<=0||height<=0)return {points:[],lines:[]};
  const scale=Math.max(1,Math.min(width,height)/450),visible=new Map();
  for(const index of MOTION_FITNESS_BODY_INDICES){
    const point=points[index];
    if(!point||![point.x,point.y,point.visibility].every(finite)||point.visibility<=0||point.visibility>1||point.x<0||point.x>1||point.y<0||point.y>1)continue;
    visible.set(index,{index,group:'body',x:point.x*width,y:point.y*height,radius:3.3*scale,color:'#ffffff'});
  }
  const lines=BODY_LINKS.filter(([a,b])=>visible.has(a)&&visible.has(b)).map(([a,b])=>({a:visible.get(a),b:visible.get(b),width:2.4*scale,color:'#91ffcd'}));
  return {points:[...visible.values()],lines};
}

export function drawMotionOverlay(context,points,width,height) {
  const geometry=buildMotionOverlay(points,width,height);
  if(!geometry.points.length)return;
  context.save();context.lineCap='round';context.shadowColor='#111827';context.shadowBlur=1;
  for(const line of geometry.lines){
    context.strokeStyle=line.color;context.lineWidth=line.width;context.beginPath();context.moveTo(line.a.x,line.a.y);context.lineTo(line.b.x,line.b.y);context.stroke();
  }
  for(const point of geometry.points){
    context.fillStyle=point.color;context.beginPath();context.arc(point.x,point.y,point.radius,0,Math.PI*2);context.fill();
  }
  context.restore();
}
