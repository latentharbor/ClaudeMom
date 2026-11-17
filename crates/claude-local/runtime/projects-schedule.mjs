// Cron expressions use wall-clock time in an explicit IANA zone. Missed ticks
// coalesce into one run; callers persist the occurrence before starting work.
function field(source,min,max) {
  const values=new Set();
  for(const item of source.split(',')) {
    const [range,stepText,...rest]=item.split('/'),step=stepText===undefined?1:Number(stepText);
    if(rest.length||!/^\d+$/.test(stepText??'1')||step<1||step>max+1)throw Error('Invalid schedule step');
    let from,to;
    if(range==='*'){from=min;to=max;}
    else if(/^\d+$/.test(range)){from=Number(range);to=stepText===undefined?from:max;}
    else if(/^\d+-\d+$/.test(range)){[from,to]=range.split('-').map(Number);}
    else throw Error('Invalid schedule field');
    if(from<min||to>max||to<from)throw Error('Schedule field is out of range');
    for(let n=from;n<=to;n+=step)values.add(n);
  }
  return values;
}
export function compileSchedule(expression,zone) {
  if(typeof expression!=='string'||expression.length>200)throw Error('Invalid cron expression');
  const parts=expression.trim().split(/\s+/);
  if(parts.length!==5)throw Error('Schedules need five cron fields');
  const [minute,hour,day,month,weekday]=parts.map((p,i)=>field(p,[0,0,1,1,0][i],[59,23,31,12,7][i]));
  if(weekday.has(7))weekday.add(0);
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',weekday:'short',hourCycle:'h23'});
  const weekdays={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return date=>{
    const values=Object.fromEntries(format.formatToParts(date).map(p=>[p.type,p.value]));
    const dom=day.has(Number(values.day)),dow=weekday.has(weekdays[values.weekday]);
    return minute.has(Number(values.minute))&&hour.has(Number(values.hour))&&month.has(Number(values.month))&&
      (parts[2]==='*'?dow:parts[4]==='*'?dom:dom||dow);
  };
}
export function nextOccurrence(schedule,after) {
  if(schedule.enabled===false)return null;
  if(schedule.run_once_at) {
    const at=Date.parse(schedule.run_once_at);
    if(!Number.isFinite(at))throw Error('Invalid one-time schedule');
    return new Date(Math.max(at,after+1)).toISOString();
  }
  const matches=compileSchedule(schedule.cron_expression,schedule.timezone||'UTC');
  let at=Math.floor(after/60000)*60000+60000;
  const end=at+367*86400000;
  for(;at<end;at+=60000)if(matches(new Date(at)))return new Date(at).toISOString();
  throw Error('Schedule has no occurrence in the next year');
}
